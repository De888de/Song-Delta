import { Telegram } from 'puregram';
import { config } from 'dotenv';
import { exec, execSync } from 'child_process';
import { promisify } from 'util';
import fs, { writeFileSync } from 'fs';
import FormData from 'form-data';
import fetch from 'node-fetch';

try {
  console.log('Installing yt-dlp...');
  execSync('pip3 install -U yt-dlp', { stdio: 'inherit' });
  console.log('yt-dlp installed successfully');
  execSync('yt-dlp --version', { stdio: 'inherit' });
} catch (e) {
  console.error('Failed to install/run yt-dlp:', e.message);
}

if (process.env.YOUTUBE_COOKIES) {
  writeFileSync('cookies.txt', process.env.YOUTUBE_COOKIES);
  console.log('cookies.txt created, length:', process.env.YOUTUBE_COOKIES.length);
} else {
  console.log('YOUTUBE_COOKIES not found');
}

const execAsync = promisify(exec);
config();

const bot = Telegram.fromToken(process.env.BOT_TOKEN);
const searchCache = new Map();
const MAX_DURATION = 360;

async function searchTracks(query) {
  const cmd = `yt-dlp "ytsearch12:${query}" --dump-json --flat-playlist --no-warnings --quiet`;
  const { stdout } = await execAsync(cmd, { maxBuffer: 1024 * 1024 * 10 });

  const lines = stdout.trim().split('\n').filter(l => l.trim());
  const tracks = [];

  for (const line of lines) {
    try {
      const data = JSON.parse(line);
      if (data.id && data.title) {
        const duration = data.duration || 0;
        if (duration > 0 && duration <= MAX_DURATION) {
          tracks.push({
            id: data.id,
            title: data.title,
            duration: data.duration_string || '',
            durationSec: duration
          });
        }
      }
    } catch {}
  }
  return tracks.slice(0, 7);
}

bot.on('message', async (ctx) => {
  const text = ctx.text?.trim();
  if (!text || text.startsWith('/')) {
    if (text === '/start') {
      await ctx.send('Отправь название песни или исполнителя.\n\nТреки длиннее 6 минут не показываются.');
    }
    return;
  }

  await ctx.send('Ищу треки...');

  try {
    const tracks = await searchTracks(text);

    if (!tracks.length) {
      return ctx.send('Ничего не нашёл (или все треки длиннее 6 минут). Попробуй другое название.');
    }

    searchCache.set(ctx.senderId, tracks);

    const buttons = tracks.map((track, i) => [
      {
        text: `${i + 1}. ${track.title.slice(0, 45)}${track.duration ? ` · ${track.duration}` : ''}`,
        callback_data: `track_${i}`
      }
    ]);

    await ctx.send(`Найдено: ${tracks.length}\nВыбери трек:`, {
      reply_markup: { inline_keyboard: buttons }
    });
  } catch (err) {
    console.error('Search error:', err);
    await ctx.send('Ошибка при поиске. Попробуй ещё раз.');
  }
});

bot.on('callback_query', async (ctx) => {
  console.log('Callback:', ctx.data);

  const data = ctx.data;
  if (!data?.startsWith('track_')) return;

  const index = parseInt(data.split('_')[1]);
  const tracks = searchCache.get(ctx.senderId);

  if (!tracks || !tracks[index]) {
    await bot.api.sendMessage({ chat_id: ctx.senderId, text: 'Результаты устарели. Поищи заново.' });
    return;
  }

  const track = tracks[index];
  console.log('Downloading:', track.title, track.id);

  await bot.api.sendMessage({ chat_id: ctx.senderId, text: `Скачиваю: ${track.title}` });

  const filename = `track_${Date.now()}.mp3`;

  try {
    const cmd = `yt-dlp "https://www.youtube.com/watch?v=${track.id}" -x --audio-format mp3 -o "${filename}" --no-playlist --no-warnings --quiet --cookies cookies.txt`;
    console.log('Running:', cmd);
    await execAsync(cmd, { timeout: 180000 });

    console.log('File exists:', fs.existsSync(filename));

    if (fs.existsSync(filename)) {
      const form = new FormData();
      form.append('chat_id', ctx.senderId);
      form.append('audio', fs.createReadStream(filename), filename);
      form.append('title', track.title);
      form.append('performer', 'Music Finder');

      const response = await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendAudio`, {
        method: 'POST',
        body: form
      });

      const result = await response.json();
      console.log('Send result:', result.ok);

      fs.unlinkSync(filename);
      if (result.ok) {
        console.log('Sent successfully');
      } else {
        await bot.api.sendMessage({ chat_id: ctx.senderId, text: 'Не удалось отправить файл.' });
      }
    } else {
      await bot.api.sendMessage({ chat_id: ctx.senderId, text: 'Не удалось скачать трек.' });
    }
  } catch (err) {
    console.error('Download error:', err.message || err);
    await bot.api.sendMessage({ chat_id: ctx.senderId, text: 'Ошибка при скачивании. Попробуй другой трек.' });
  }
});

bot.startPolling()
  .then(() => console.log('Music Bot запущен'))
  .catch(err => console.error(err));

import fs from 'node:fs';
import { execFile } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';
import { config } from './config.js';

/**
 * Browsers record audio in different containers (Chrome/Android: WebM/Opus, Firefox: Ogg,
 * Safari: MP4) and often leave out the duration, so a recording made on one device may not
 * play, or seek, on another. Converting to AAC in an .m4a plays everywhere.
 * Resolves true when `dest` was written; false (and no file) if ffmpeg isn't available or fails.
 */
export function toM4a(src, dest) {
  return new Promise((resolve) => {
    if (!ffmpegPath) return resolve(false);
    execFile(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', '-y', '-i', src,
      '-vn', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-f', 'ipod', dest,
    ], { timeout: config.jobTimeout }, (err) => {
      if (err) fs.rm(dest, { force: true }, () => resolve(false));
      else resolve(true);
    });
  });
}

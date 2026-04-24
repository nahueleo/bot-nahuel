import { createReadStream } from 'fs';
import { writeFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import Groq from 'groq-sdk';
import { config } from '../config/index.js';

const groq = new Groq({ apiKey: config.groq.apiKey });

// Extensiones de archivo por MIME type de audio que WhatsApp puede enviar
const MIME_TO_EXT = {
  'audio/ogg': 'ogg',
  'audio/ogg; codecs=opus': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'mp4',
  'audio/aac': 'aac',
  'audio/amr': 'amr',
  'audio/webm': 'webm',
  'audio/wav': 'wav',
};

/**
 * Transcribe un buffer de audio usando Groq Whisper large-v3.
 * Escribe el buffer a un archivo temporal, transcribe, y limpia.
 * @param {Buffer} audioBuffer
 * @param {string} mimeType
 * @returns {Promise<string>} Texto transcripto
 */
export async function transcribeAudio(audioBuffer, mimeType) {
  const ext = MIME_TO_EXT[mimeType] || MIME_TO_EXT[mimeType.split(';')[0].trim()] || 'ogg';
  const tmpPath = join(tmpdir(), `wa_audio_${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`);

  try {
    await writeFile(tmpPath, audioBuffer);

    const transcription = await groq.audio.transcriptions.create({
      file: createReadStream(tmpPath),
      model: 'whisper-large-v3',
      language: 'es',
      response_format: 'text',
    });

    return typeof transcription === 'string' ? transcription.trim() : transcription.text?.trim() || '';
  } finally {
    await unlink(tmpPath).catch(() => {});
  }
}

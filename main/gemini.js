import { FRAME_NAMES } from '../renderer/shared/sprite-slicer.js';
import { log } from './log.js';

// 直接打 REST，不用 SDK（少一個相依）。金鑰走 header，不走 query string。
export const MODEL = 'gemini-3.1-flash-image';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
const TIMEOUT_MS = 90_000;

// 提示詞與 FRAME_NAMES 的順序綁死：第一列走路 4 格，第二列 idle / 蹲 / 空中 / 落地。
const PROMPT = [
  'Here is a reference image of a character. Create a 2D game sprite sheet of EXACTLY this same character:',
  'identical colors, markings, proportions, face and art style. Keep the character recognizable as the one in the reference.',
  'Arrange exactly 8 poses in a grid of 2 rows x 4 columns. Every pose must sit in the center of its own cell with at least 15% empty margin',
  'on all sides of the cell, so no two poses touch or overlap. All poses at the same scale, side view facing RIGHT.',
  'Row 1 (left to right): walk cycle, 4 frames with legs in different phases.',
  'Row 2 (left to right): idle standing; crouching before a jump; mid-air jump with legs tucked; landing.',
  'Flat solid pure magenta background #FF00FF everywhere. No shadows, no ground line, no text, no labels, no borders, no grid lines.',
].join(' ');

export class GeminiError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/**
 * @param {string} apiKey
 * @param {{ mimeType: string, base64: string }} image 使用者上傳的圖
 * @returns {Promise<{ mimeType: string, base64: string }>} 生成的 sprite sheet
 */
export async function generateSpriteSheet(apiKey, image) {
  if (!apiKey) throw new GeminiError('NO_KEY', '尚未設定 Gemini 金鑰');
  const body = {
    contents: [{ parts: [{ inlineData: { mimeType: image.mimeType, data: image.base64 } }, { text: PROMPT }] }],
    generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '16:9' } },
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw new GeminiError('TIMEOUT', `Gemini 超過 ${TIMEOUT_MS / 1000} 秒沒回應`);
    log('error', 'gemini network error', { message: err.message });
    throw new GeminiError('NETWORK', '連不上 Gemini，請檢查網路');
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  if (!res.ok) {
    log('error', 'gemini http error', { status: res.status, body: text.slice(0, 500) });
    if (res.status === 400 && /API key/i.test(text)) throw new GeminiError('AUTH', '金鑰無效，請往下捲到「Gemini 金鑰」重新貼上');
    if (res.status === 401 || res.status === 403) throw new GeminiError('AUTH', '金鑰無效或沒有權限（可能是帳務問題），請往下捲到「Gemini 金鑰」檢查');
    if (res.status === 429) throw new GeminiError('QUOTA', '配額用完或請求太頻繁，稍後再試');
    throw new GeminiError('HTTP', `Gemini 暫時無法服務（回應 ${res.status}）`);
  }
  let json;
  try { json = JSON.parse(text); } catch { throw new GeminiError('HTTP', 'Gemini 回了看不懂的內容'); }
  const parts = json?.candidates?.[0]?.content?.parts ?? [];
  const imagePart = parts.find((p) => p.inlineData?.data);
  if (!imagePart) {
    log('error', 'gemini returned no image', { finishReason: json?.candidates?.[0]?.finishReason, promptFeedback: json?.promptFeedback });
    throw new GeminiError('NO_IMAGE', '模型沒有回傳圖片（可能被安全過濾擋下），換一張圖試試');
  }
  return { mimeType: imagePart.inlineData.mimeType, base64: imagePart.inlineData.data, frameNames: FRAME_NAMES };
}

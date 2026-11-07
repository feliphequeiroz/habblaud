// Eventos da ponte do DeepSeek Harness (POST /api/dsh/events). A ponte `npm run dsh:bridge` roda no mesmo
// computador, lê a sessão do DSH e manda um evento por vez. Como os eventos do Codex, só observam e só valem vindos
// do próprio computador (a trava de Host/conexão é conferida em http/app.ts).
import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError, readJson, sendJson } from '../http/app';
import { parseDshEvent, type DshLive } from '../sources/dsh/source';
import { tr } from '../../shared/i18n';

export async function handleDshEvent(req: IncomingMessage, res: ServerResponse, deps: { live?: DshLive }): Promise<void> {
  let body;
  try {
    body = parseDshEvent(await readJson(req));
  } catch (err) {
    throw new HttpError(400, err instanceof Error ? err.message : tr('evento inválido'));
  }
  let ok = false;
  if (deps.live) {
    try {
      ok = deps.live.applyEvent(body) === true;
    } catch {
      ok = false;
    }
  }
  sendJson(res, 200, { ok });
}

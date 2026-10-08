import type { IncomingMessage, ServerResponse } from 'node:http'
import { handleAdminAuth } from '../../server/adminAuth'

type FunctionRequest = IncomingMessage & { body?: unknown }

export default async function handler(req: FunctionRequest, res: ServerResponse) {
  const pathname = new URL(req.url || '/', 'http://localhost').pathname
  const action = pathname.split('/').at(-1) || ''
  await handleAdminAuth(req, res, action)
}

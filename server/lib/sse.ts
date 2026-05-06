import type { Response } from 'express'

export function initSSE(res: Response) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.flushHeaders()
}

export function sendSSE(res: Response, event: string, data: unknown) {
  if (res.writableEnded) return
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

export function endSSE(res: Response) {
  if (res.writableEnded) return
  res.write('event: done\ndata: {}\n\n')
  res.end()
}

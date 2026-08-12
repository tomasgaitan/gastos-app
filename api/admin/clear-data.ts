import type { VercelRequest, VercelResponse } from '@vercel/node'
import { google } from 'googleapis'
import { resolveTenantSheetId } from '../_lib/tenants.js'

const CLEAR_TOKEN = 'd117a120-d1cb-4979-a908-02c4d1c69a1b'

const TABS = [
  'expenses',
  'expense_splits',
  'personal_expenses',
  'settlements',
  'members',
  'categories',
  'exchange_rates',
]

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { token, tenantId } = req.body as { token?: string; tenantId?: string }

  if (token !== CLEAR_TOKEN) return res.status(401).json({ error: 'Unauthorized' })
  if (!tenantId) return res.status(400).json({ error: 'tenantId requerido' })

  let sheetId: string
  try { sheetId = await resolveTenantSheetId(tenantId) }
  catch { return res.status(404).json({ error: 'Tenant no encontrado' }) }

  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  })
  const sheets = google.sheets({ version: 'v4', auth })

  const results: Record<string, string> = {}
  for (const tab of TABS) {
    try {
      await sheets.spreadsheets.values.clear({
        spreadsheetId: sheetId,
        range: `${tab}!A2:ZZ`,
      })
      results[tab] = 'cleared'
    } catch (err: any) {
      results[tab] = `error: ${err.message}`
    }
  }

  return res.status(200).json({ ok: true, results })
}

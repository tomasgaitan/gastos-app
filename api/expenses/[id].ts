import type { VercelRequest, VercelResponse } from '@vercel/node'
import { readRows, findRow, findRows, updateRow, deleteRows, appendRow } from '../_lib/sheets.js'
import { rowToExpense, expenseToRow, rowToSplit, rowToMember, splitToRow } from '../_lib/mappers.js'
import { calculateSplits } from '../_lib/calculations.js'
import { resolveTenantSheetId } from '../_lib/tenants.js'
import type { Expense, ExpenseSplit, ExpenseWithSplits, NewExpensePayload } from '../../src/types/index.js'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const { id, tenantId: tenantIdParam } = req.query as { id: string; tenantId?: string }
  if (!tenantIdParam) return res.status(400).json({ error: 'tenantId requerido' })
  let sheetId: string
  try { sheetId = await resolveTenantSheetId(tenantIdParam) }
  catch { return res.status(404).json({ error: 'Tenant no encontrado' }) }

  if (req.method === 'GET') {
    const [found, splitRows] = await Promise.all([
      findRow(sheetId, 'expenses', 0, id),
      findRows(sheetId, 'expense_splits', 1, id),
    ])
    if (!found) return res.status(404).json({ error: 'Expense not found' })
    const expense = rowToExpense(found.row)
    const splits = splitRows.map(r => rowToSplit(r.row))
    return res.status(200).json({ ...expense, splits } as ExpenseWithSplits)
  }

  if (req.method === 'PUT') {
    const { payload, exchangeRate } = req.body as { payload: NewExpensePayload; exchangeRate: number }

    const found = await findRow(sheetId, 'expenses', 0, id)
    if (!found) return res.status(404).json({ error: 'Expense not found' })

    const existing = rowToExpense(found.row)
    const updated: Expense = {
      ...existing,
      description: payload.description,
      amount: payload.amount,
      currency: payload.currency,
      paid_by: payload.paid_by,
      category: payload.category,
      date: payload.date,
      is_recurring: payload.is_recurring,
      recurrence_type: payload.recurrence_type,
      installments_count: payload.installments_count ?? null,
      variable_amount: payload.variable_amount ?? false,
      notes: payload.notes || null,
      updated_at: new Date().toISOString(),
    }
    await updateRow(sheetId, 'expenses', found.rowNumber, expenseToRow(updated))

    // Leer splits existentes para determinar si cambiaron los excluidos
    const oldSplits = await findRows(sheetId, 'expense_splits', 1, id)
    const existingSplits = oldSplits.map(r => rowToSplit(r.row))

    const existingExcludedIds = existingSplits
      .filter(s => s.is_excluded)
      .map(s => s.user_id)
      .sort()
    const newExcludedIds = [...(payload.excluded_member_ids || [])].sort()
    const exclusionsChanged =
      existingExcludedIds.length !== newExcludedIds.length ||
      existingExcludedIds.some((eid, i) => eid !== newExcludedIds[i])

    let newSplits: ExpenseSplit[]

    if (exclusionsChanged) {
      // Excluidos cambiaron: recalcular desde salarios actuales
      const memberRows = await readRows(sheetId, 'members')
      const members = memberRows.map(rowToMember)
      const splits = calculateSplits(payload.amount, members, payload.excluded_member_ids, exchangeRate)
      newSplits = splits.map(s => ({
        id: crypto.randomUUID(),
        expense_id: id,
        user_id: s.member_id,
        percentage: s.percentage,
        amount: s.amount,
        is_excluded: s.is_excluded,
      }))
    } else {
      // Excluidos no cambiaron: preservar porcentajes históricos, recalcular montos sobre el nuevo importe
      newSplits = existingSplits.map(s => ({
        ...s,
        id: crypto.randomUUID(),
        amount: s.is_excluded ? 0 : (s.percentage / 100) * payload.amount,
      }))
    }

    await deleteRows(sheetId, 'expense_splits', oldSplits.map(r => r.rowNumber))
    for (const split of newSplits) {
      await appendRow(sheetId, 'expense_splits', splitToRow(split))
    }

    return res.status(200).json({ ...updated, splits: newSplits })
  }

  if (req.method === 'DELETE') {
    const [found, splitRows] = await Promise.all([
      findRow(sheetId, 'expenses', 0, id),
      findRows(sheetId, 'expense_splits', 1, id),
    ])
    if (!found) return res.status(404).json({ error: 'Expense not found' })
    await deleteRows(sheetId, 'expense_splits', splitRows.map(r => r.rowNumber))
    await deleteRows(sheetId, 'expenses', [found.rowNumber])
    return res.status(204).end()
  }

  return res.status(405).json({ error: 'Method not allowed' })
}

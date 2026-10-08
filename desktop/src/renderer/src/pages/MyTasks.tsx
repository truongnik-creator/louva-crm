import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { getApiErrorMessage } from '../lib/api'
import { completeTask, fetchMyTasksToday, TASK_KIND_LABEL, type MyTask } from '../lib/api-lo4'
import { dateTimeVi } from '../lib/format'
import { Empty, useToast } from '../components/ui'

/* F27: VIỆC CỦA TÔI HÔM NAY. Gom theo nhóm: quá hạn, gọi lại, nhắc cọc, chăm sóc,
   khác. Việc chăm sóc sau điều trị bấm "Đã liên hệ" ở màn Chăm sóc để ghi kết quả. */

const GROUPS: Array<{ key: string; t: string; kinds: string[] }> = [
  { key: 'callback', t: 'Gọi lại', kinds: ['CALLBACK', 'CARE_AGAIN'] },
  { key: 'deposit', t: 'Nhắc cọc', kinds: ['DEPOSIT_REMINDER'] },
  { key: 'care', t: 'Chăm sóc, tái tiêm', kinds: ['AFTERCARE', 'RETREAT'] },
  { key: 'other', t: 'Việc khác', kinds: ['MANUAL_MESSAGE', 'OTHER'] }
]

export function notifyTaskBadge(): void {
  window.dispatchEvent(new Event('tasks:changed'))
}

export default function MyTasks(): React.JSX.Element {
  const { say, fail } = useToast()
  const navigate = useNavigate()
  const [tasks, setTasks] = useState<MyTask[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setTasks(await fetchMyTasksToday())
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [fail])

  useEffect(() => {
    void load()
  }, [load])

  const overdue = useMemo(() => tasks.filter((t) => t.overdue), [tasks])

  const done = async (t: MyTask): Promise<void> => {
    if (t.kind === 'AFTERCARE' || t.kind === 'RETREAT') {
      navigate('/hau-phau')
      return
    }
    try {
      await completeTask(t.id)
      say('Đã xong việc.')
      notifyTaskBadge()
      void load()
    } catch (err) {
      fail(getApiErrorMessage(err))
    }
  }

  const row = (t: MyTask): React.JSX.Element => (
    <tr key={t.id}>
      <td>
        <span className="tag">{TASK_KIND_LABEL[t.kind] ?? t.kind}</span>
      </td>
      <td>
        <b>{t.title}</b>
        {t.description ? <div className="muted" style={{ fontSize: 12, whiteSpace: 'pre-line' }}>{t.description}</div> : null}
      </td>
      <td style={{ cursor: t.customer ? 'pointer' : undefined }} onClick={() => t.customer && navigate(`/khach-hang/${t.customer.id}`)}>
        {t.customer ? (
          <>
            {t.customer.name}
            <div className="muted" style={{ fontSize: 11.5 }}>{t.customer.phone ?? ''}</div>
          </>
        ) : null}
      </td>
      <td style={{ color: t.overdue ? 'var(--danger)' : undefined, width: 140 }}>{t.dueAt ? dateTimeVi(t.dueAt) : 'Không hạn'}</td>
      <td style={{ width: 110 }}>
        <button className="btn sm" onClick={() => void done(t)}>
          {t.kind === 'AFTERCARE' || t.kind === 'RETREAT' ? 'Ghi liên hệ' : 'Xong'}
        </button>
      </td>
    </tr>
  )

  if (loading) return <Empty>Đang tải…</Empty>

  return (
    <>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)', marginBottom: 12 }}>
        <div className="kpi">
          <div className="lab">Việc hôm nay</div>
          <div className="val">{tasks.length}</div>
        </div>
        <div className="kpi">
          <div className="lab">Quá hạn</div>
          <div className="val" style={{ color: overdue.length ? 'var(--danger)' : undefined }}>{overdue.length}</div>
        </div>
      </div>
      {!tasks.length ? <Empty>Hôm nay không còn việc nào. Tốt lắm!</Empty> : null}
      {overdue.length ? (
        <div className="card" style={{ padding: 0, overflow: 'hidden', marginBottom: 12 }}>
          <div className="sec-title" style={{ padding: '12px 14px 0', color: 'var(--danger)' }}>Quá hạn</div>
          <table>
            <tbody>{overdue.map(row)}</tbody>
          </table>
        </div>
      ) : null}
      {GROUPS.map((g) => {
        const known = GROUPS.filter((x) => x.key !== 'other').flatMap((x) => x.kinds)
        const list = tasks.filter(
          (t) => !t.overdue && (g.key === 'other' ? !known.includes(t.kind) : g.kinds.includes(t.kind))
        )
        if (!list.length) return null
        return (
          <div key={g.key} className="card" style={{ padding: 0, overflow: 'hidden', marginBottom: 12 }}>
            <div className="sec-title" style={{ padding: '12px 14px 0' }}>
              {g.t} ({list.length})
            </div>
            <table>
              <tbody>{list.map(row)}</tbody>
            </table>
          </div>
        )
      })}
    </>
  )
}

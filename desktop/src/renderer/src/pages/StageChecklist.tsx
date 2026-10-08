import React, { useCallback, useEffect, useState } from 'react'
import { getApiErrorMessage } from '../lib/api'
import { useAuth } from '../lib/auth-context'
import { useClinic } from '../lib/clinic-context'
import { createChecklistItem, fetchChecklist, updateChecklistItem, type ChecklistItem } from '../lib/api-lo8'
import { Empty, Modal, useToast } from '../components/ui'

/* Lô 8 · J3: VIỆC THEO BƯỚC. Mỗi bước có checklist việc kèm mẫu tin gợi ý; cơ
   hội vào bước thì tự sinh việc cho sale phụ trách (trang Việc của tôi). Quản lý
   cơ sở khai cho cơ sở mình; việc áp mọi cơ sở cần quyền toàn hệ thống. */

interface Draft {
  id?: string
  stage: string
  title: string
  messageTemplate: string
  dueDays: number
  sortOrder: number
  branchId: string | null
}

export default function StageChecklist(): React.JSX.Element {
  const clinic = useClinic()
  const { user, scopeOf } = useAuth()
  const { say, fail } = useToast()
  const [data, setData] = useState<{ items: ChecklistItem[]; canManage: boolean } | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [busy, setBusy] = useState(false)
  const allBranches = scopeOf('pipeline.manage') === 'ALL'
  const branches = user?.branches ?? []

  const load = useCallback(() => {
    fetchChecklist()
      .then(setData)
      .catch((err) => fail(getApiErrorMessage(err)))
  }, [fail])
  useEffect(() => load(), [load])

  const save = async () => {
    if (!draft) return
    setBusy(true)
    try {
      const body = {
        stage: draft.stage,
        title: draft.title.trim(),
        messageTemplate: draft.messageTemplate.trim() || null,
        dueDays: draft.dueDays,
        sortOrder: draft.sortOrder,
        branchId: draft.branchId
      }
      if (draft.id) await updateChecklistItem(draft.id, body)
      else await createChecklistItem(body)
      say('Đã lưu việc theo bước.')
      setDraft(null)
      load()
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }
  const toggle = async (i: ChecklistItem) => {
    try {
      await updateChecklistItem(i.id, { active: !i.active })
      load()
    } catch (err) {
      fail(getApiErrorMessage(err))
    }
  }

  if (!data) return <div className="card"><Empty>Đang tải…</Empty></div>
  const stages = clinic.stages.filter((s) => !s.lost)
  const branchName = (id: string | null) => (id ? (branches.find((b) => b.id === id)?.shortName ?? branches.find((b) => b.id === id)?.name ?? 'Cơ sở khác') : 'Mọi cơ sở')
  return (
    <>
      <div className="row" style={{ marginBottom: 10 }}>
        <div className="muted" style={{ fontSize: 12.5 }}>
          Cơ hội vào bước thì tự tạo các việc dưới đây cho sale phụ trách, kèm mẫu tin gợi ý (không tự gửi). Bật tắt chung ở Cài đặt (pipeline.stageTasks.enabled).
        </div>
        {data.canManage ? (
          <button
            className="btn sm"
            style={{ marginLeft: 'auto' }}
            onClick={() => setDraft({ stage: stages[0]?.key ?? '', title: '', messageTemplate: '', dueDays: 0, sortOrder: 0, branchId: allBranches ? null : (branches[0]?.id ?? null) })}
          >
            + Thêm việc
          </button>
        ) : null}
      </div>
      {stages.map((st) => {
        const items = data.items.filter((i) => i.stage === st.key)
        return (
          <div key={st.key} className="card" style={{ marginBottom: 10 }}>
            <div className="sec-title">
              <span className="tag" style={{ background: st.bg, color: st.fg }}>
                {st.label}
              </span>{' '}
              · {items.filter((i) => i.active).length} việc
            </div>
            {items.length === 0 ? (
              <Empty>Chưa có việc cho bước này.</Empty>
            ) : (
              items.map((i) => (
                <div key={i.id} className="row" style={{ padding: '6px 0', borderBottom: '1px dashed var(--border)', gap: 8, opacity: i.active ? 1 : 0.55 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <b>{i.title}</b>
                    {i.isSample ? <span className="hchip WARM" style={{ marginLeft: 6 }}>Mẫu, chờ chủ duyệt</span> : null}
                    <div className="muted" style={{ fontSize: 12 }}>
                      Hạn {i.dueDays === 0 ? 'trong ngày vào bước' : `${i.dueDays} ngày sau khi vào bước`} · {branchName(i.branchId)}
                      {i.active ? '' : ' · đang tắt'}
                    </div>
                    {i.messageTemplate ? <div style={{ fontSize: 12, marginTop: 2 }}>Mẫu tin: {i.messageTemplate}</div> : null}
                  </div>
                  {data.canManage ? (
                    <>
                      <button
                        className="btn sec sm"
                        onClick={() => setDraft({ id: i.id, stage: i.stage, title: i.title, messageTemplate: i.messageTemplate ?? '', dueDays: i.dueDays, sortOrder: i.sortOrder, branchId: i.branchId })}
                      >
                        Sửa
                      </button>
                      <button className="btn sec sm" onClick={() => void toggle(i)}>
                        {i.active ? 'Tắt' : 'Bật'}
                      </button>
                    </>
                  ) : null}
                </div>
              ))
            )}
          </div>
        )
      })}
      {draft ? (
        <Modal
          title={draft.id ? 'Sửa việc theo bước' : 'Thêm việc theo bước'}
          onClose={() => setDraft(null)}
          width={520}
          footer={
            <>
              <button className="btn sec" onClick={() => setDraft(null)}>
                Huỷ
              </button>
              <button className="btn" disabled={busy || draft.title.trim().length < 3} onClick={() => void save()}>
                Lưu
              </button>
            </>
          }
        >
          <div className="grid2">
            <div className="field">
              <label>Bước</label>
              <select className="input" value={draft.stage} onChange={(e) => setDraft({ ...draft, stage: e.target.value })}>
                {stages.map((s) => (
                  <option key={s.key} value={s.key}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>Cơ sở</label>
              <select className="input" value={draft.branchId ?? ''} onChange={(e) => setDraft({ ...draft, branchId: e.target.value || null })}>
                {allBranches ? <option value="">Mọi cơ sở</option> : null}
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.shortName ?? b.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="field">
            <label>Việc cần làm</label>
            <input className="input" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
          </div>
          <div className="field">
            <label>Mẫu tin gợi ý (không bắt buộc, không tự gửi)</label>
            <textarea className="input" rows={3} value={draft.messageTemplate} onChange={(e) => setDraft({ ...draft, messageTemplate: e.target.value })} />
          </div>
          <div className="grid2">
            <div className="field">
              <label>Hạn: số ngày sau khi vào bước</label>
              <input className="input" type="number" min={0} max={60} value={draft.dueDays} onChange={(e) => setDraft({ ...draft, dueDays: Math.max(0, Number(e.target.value) || 0) })} />
            </div>
            <div className="field">
              <label>Thứ tự</label>
              <input className="input" type="number" min={0} max={999} value={draft.sortOrder} onChange={(e) => setDraft({ ...draft, sortOrder: Math.max(0, Number(e.target.value) || 0) })} />
            </div>
          </div>
        </Modal>
      ) : null}
    </>
  )
}

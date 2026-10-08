import React, { useCallback, useEffect, useState } from 'react'
import { fetchServices, getApiErrorMessage } from '../lib/api'
import { useAuth } from '../lib/auth-context'
import {
  createUpsellRule,
  fetchUpsellRules,
  fetchUpsellStats,
  reviewUpsellRule,
  updateUpsellRule,
  type UpsellRule,
  type UpsellStatRow
} from '../lib/api-lo7'
import { Empty, Modal, useToast } from '../components/ui'

/* Lô 7 · V2: LUẬT GỢI Ý BÁN KÈM. Quản lý cơ sở, giám đốc khai luật (dịch vụ A
   gợi ý B, lời gợi ý, điều kiện); bác sĩ duyệt chuyên môn để gỡ nhãn "mẫu".
   Tỉ lệ khách nhận gợi ý chỉ để đo, không nối lương thưởng. */

interface Draft {
  id?: string
  triggerServiceId: string
  suggestServiceId: string
  pitch: string
  conditionNote: string
  priority: number
  onlyIfNotDone: boolean
  branchId: string | null
}

export default function UpsellRules(): React.JSX.Element {
  const { user, scopeOf, can } = useAuth()
  const { say, fail } = useToast()
  const [data, setData] = useState<{ items: UpsellRule[]; canManage: boolean; canReview: boolean } | null>(null)
  const [services, setServices] = useState<Array<{ id: string; name: string }>>([])
  const [stats, setStats] = useState<UpsellStatRow[] | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [busy, setBusy] = useState(false)
  const allBranches = scopeOf('upsell.manage') === 'ALL'

  const load = useCallback(() => {
    fetchUpsellRules()
      .then(setData)
      .catch((err) => fail(getApiErrorMessage(err)))
    if (can('upsell.manage') || can('accounting.read')) {
      fetchUpsellStats(30)
        .then((r) => setStats(r.items))
        .catch(() => setStats(null))
    }
  }, [fail, can])

  useEffect(() => {
    load()
    fetchServices().then((s) => setServices(s.filter((x) => (x as { active?: boolean }).active !== false).map((x) => ({ id: x.id, name: x.name })))).catch(() => undefined)
  }, [load])

  const save = async (): Promise<void> => {
    if (!draft) return
    setBusy(true)
    try {
      const body = {
        triggerServiceId: draft.triggerServiceId,
        suggestServiceId: draft.suggestServiceId,
        pitch: draft.pitch,
        conditionNote: draft.conditionNote || null,
        priority: draft.priority,
        onlyIfNotDone: draft.onlyIfNotDone,
        branchId: draft.branchId
      }
      if (draft.id) await updateUpsellRule(draft.id, body)
      else await createUpsellRule(body)
      say('Đã lưu luật bán kèm.')
      setDraft(null)
      load()
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const act = async (fn: () => Promise<unknown>, ok: string): Promise<void> => {
    try {
      await fn()
      say(ok)
      load()
    } catch (err) {
      fail(getApiErrorMessage(err))
    }
  }

  if (!data) return <div className="card"><Empty>Đang tải luật bán kèm…</Empty></div>
  const statOf = (r: UpsellRule) => stats?.find((s) => s.ruleId === r.id)
  const defaultBranch = allBranches ? null : (user?.branches[0]?.id ?? null)

  return (
    <>
      <div className="row" style={{ marginBottom: 10, flexWrap: 'wrap' }}>
        <div className="muted" style={{ fontSize: 12.5, flex: 1, minWidth: 240 }}>
          Gợi ý hiện ở phiếu tư vấn, màn chốt tại quầy, cột hồ sơ trong hộp thư và thẻ cột Đến cơ sở. Luật có nhãn “mẫu” là do đội
          code đặt để thử, phải được bác sĩ duyệt chuyên môn. Tỉ lệ nhận 30 ngày gần nhất chỉ để đo, không tính lương.
        </div>
        {data.canManage ? (
          <button
            className="btn"
            onClick={() =>
              setDraft({ triggerServiceId: '', suggestServiceId: '', pitch: '', conditionNote: '', priority: 0, onlyIfNotDone: true, branchId: defaultBranch })
            }
          >
            + Thêm luật
          </button>
        ) : null}
      </div>
      <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
        {data.items.length === 0 ? (
          <Empty>Chưa có luật bán kèm nào.</Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Khi khách làm</th>
                <th>Gợi ý thêm</th>
                <th>Lời gợi ý · điều kiện</th>
                <th>Ưu tiên</th>
                <th>Trạng thái</th>
                <th>Tỉ lệ nhận (30 ngày)</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.items.map((r) => {
                const st = statOf(r)
                return (
                  <tr key={r.id} style={r.active ? undefined : { opacity: 0.55 }}>
                    <td>{r.triggerService.name}</td>
                    <td>
                      <b>{r.suggestService.name}</b>
                    </td>
                    <td style={{ maxWidth: 340 }}>
                      {r.pitch}
                      {r.conditionNote ? <div className="muted" style={{ fontSize: 11.5 }}>Điều kiện: {r.conditionNote}</div> : null}
                      {r.onlyIfNotDone ? <div className="muted" style={{ fontSize: 11.5 }}>Bỏ qua khách đã từng làm dịch vụ gợi ý</div> : null}
                    </td>
                    <td>{r.priority}</td>
                    <td>
                      {r.isSample ? <span className="hchip WARM">Mẫu, chờ bác sĩ duyệt</span> : r.reviewedAt ? <span className="hchip PAID">Bác sĩ đã duyệt</span> : <span className="hchip NEUTRAL">Chưa duyệt chuyên môn</span>}
                      {!r.active ? <div className="muted" style={{ fontSize: 11.5 }}>Đang tắt</div> : null}
                    </td>
                    <td>{st ? `${st.accepted}/${st.suggested}${st.acceptRate != null ? ` · ${Math.round(st.acceptRate * 100)}%` : ''}` : '—'}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {data.canReview && (r.isSample || !r.reviewedAt) ? (
                        <button className="btn sm" onClick={() => void act(() => reviewUpsellRule(r.id), 'Đã duyệt chuyên môn.')}>
                          Duyệt
                        </button>
                      ) : null}{' '}
                      {data.canManage ? (
                        <>
                          <button
                            className="btn sec sm"
                            onClick={() =>
                              setDraft({
                                id: r.id,
                                triggerServiceId: r.triggerServiceId,
                                suggestServiceId: r.suggestServiceId,
                                pitch: r.pitch,
                                conditionNote: r.conditionNote ?? '',
                                priority: r.priority,
                                onlyIfNotDone: r.onlyIfNotDone,
                                branchId: r.branchId
                              })
                            }
                          >
                            Sửa
                          </button>{' '}
                          <button className="btn sec sm" onClick={() => void act(() => updateUpsellRule(r.id, { active: !r.active }), r.active ? 'Đã tắt luật.' : 'Đã bật luật.')}>
                            {r.active ? 'Tắt' : 'Bật'}
                          </button>
                        </>
                      ) : null}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {draft ? (
        <Modal
          title={draft.id ? 'Sửa luật bán kèm' : 'Thêm luật bán kèm'}
          onClose={() => setDraft(null)}
          width={520}
          footer={
            <>
              <button className="btn sec" onClick={() => setDraft(null)}>
                Huỷ
              </button>
              <button className="btn" disabled={busy || !draft.triggerServiceId || !draft.suggestServiceId || draft.pitch.trim().length < 5} onClick={() => void save()}>
                {busy ? 'Đang lưu…' : 'Lưu'}
              </button>
            </>
          }
        >
          <div className="field">
            <label>Khi khách làm hoặc quan tâm dịch vụ</label>
            <select className="input" value={draft.triggerServiceId} onChange={(e) => setDraft({ ...draft, triggerServiceId: e.target.value })}>
              <option value="">Chọn dịch vụ</option>
              {services.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>Gợi ý thêm dịch vụ</label>
            <select className="input" value={draft.suggestServiceId} onChange={(e) => setDraft({ ...draft, suggestServiceId: e.target.value })}>
              <option value="">Chọn dịch vụ</option>
              {services.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>Lời gợi ý cho tư vấn viên</label>
            <textarea className="input" rows={3} value={draft.pitch} onChange={(e) => setDraft({ ...draft, pitch: e.target.value })} />
          </div>
          <div className="field">
            <label>Điều kiện áp dụng (bằng lời)</label>
            <input className="input" value={draft.conditionNote} onChange={(e) => setDraft({ ...draft, conditionNote: e.target.value })} />
          </div>
          <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
            <div className="field" style={{ width: 120 }}>
              <label>Ưu tiên</label>
              <input className="input" type="number" value={draft.priority} onChange={(e) => setDraft({ ...draft, priority: Number(e.target.value) || 0 })} />
            </div>
            {user && user.branches.length > 1 ? (
              <div className="field" style={{ flex: 1 }}>
                <label>Cơ sở áp dụng</label>
                <select className="input" value={draft.branchId ?? ''} onChange={(e) => setDraft({ ...draft, branchId: e.target.value || null })}>
                  {allBranches ? <option value="">Mọi cơ sở</option> : null}
                  {user.branches.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.shortName ?? b.name}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
          </div>
          <label style={{ fontSize: 13 }}>
            <input type="checkbox" checked={draft.onlyIfNotDone} onChange={(e) => setDraft({ ...draft, onlyIfNotDone: e.target.checked })} /> Không gợi ý cho khách đã từng làm dịch vụ này
          </label>
          {draft.id ? <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>Sửa dịch vụ, lời gợi ý hoặc điều kiện thì luật phải được bác sĩ duyệt lại.</div> : null}
        </Modal>
      ) : null}
    </>
  )
}

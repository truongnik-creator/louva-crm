import React, { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { fetchQueue, getApiErrorMessage, setVisitStatus } from '../lib/api'
import { useAuth } from '../lib/auth-context'
import { hhmm, minutesLabel } from '../lib/format'
import { onSocket } from '../lib/socket'
import { tagStyleOf, VISIT_STATUS } from '../lib/ui'
import { Empty, Tag, useToast } from '../components/ui'
import type { Visit } from '../lib/types'

/* LỄ TÂN · KHÁCH ĐÃ ĐẾN — hàng đợi thời gian thực.
   Ngưỡng chờ 20 phút tô đỏ: đây là con số lễ tân cần nhìn thấy ngay, vì thời
   gian chờ là chỉ số vận hành bị phàn nàn nhiều nhất ở phòng khám. */

const LATE_MINUTES = 20

const NEXT_STATUS: Record<string, { next: string; label: string }> = {
  WAITING: { next: 'CONSULTING', label: 'Gọi vào tư vấn' },
  CONSULTING: { next: 'IN_SERVICE', label: 'Chuyển sang làm dịch vụ' },
  IN_SERVICE: { next: 'PAYING', label: 'Chuyển sang thanh toán' },
  PAYING: { next: 'DONE', label: 'Hoàn tất' }
}

export default function Queue(): React.JSX.Element {
  const { can, branchId } = useAuth()
  const { say, fail } = useToast()
  const navigate = useNavigate()

  const [visits, setVisits] = useState<Visit[]>([])
  const [includeFinished, setIncludeFinished] = useState(false)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    try {
      setVisits(await fetchQueue(includeFinished ? { includeFinished: '1' } : {}))
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [includeFinished, fail])

  useEffect(() => {
    void load()
  }, [load, branchId])

  // Lễ tân check-in ở máy khác thì máy này phải thấy ngay, không cần F5.
  useEffect(() => {
    const off = onSocket('queue:updated', () => void load())
    return off
  }, [load])

  // Thời gian chờ trôi theo phút — cập nhật lại để con số không đứng yên.
  useEffect(() => {
    const timer = window.setInterval(() => void load(), 60_000)
    return () => window.clearInterval(timer)
  }, [load])

  const advance = useCallback(
    async (visit: Visit) => {
      const step = NEXT_STATUS[visit.status]
      if (!step) return
      try {
        await setVisitStatus(visit.id, step.next)
        say(`${visit.customer.name}: ${step.label.toLowerCase()}.`)
        void load()
      } catch (err) {
        fail(getApiErrorMessage(err))
      }
    },
    [say, fail, load]
  )

  const waiting = visits.filter((v) => v.status === 'WAITING')
  const active = visits.filter((v) => !['WAITING', 'DONE', 'LEFT'].includes(v.status))
  const late = waiting.filter((v) => v.waitingMinutes >= LATE_MINUTES)

  return (
    <>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)', marginBottom: 12 }}>
        <div className="kpi">
          <div className="lab">Khách trong phòng khám</div>
          <div className="val">{waiting.length + active.length}</div>
        </div>
        <div className="kpi">
          <div className="lab">Đang chờ</div>
          <div className="val">{waiting.length}</div>
        </div>
        <div className="kpi">
          <div className="lab">Đang được phục vụ</div>
          <div className="val">{active.length}</div>
        </div>
        <div className="kpi">
          <div className="lab">Chờ quá {LATE_MINUTES} phút</div>
          <div className="val" style={{ color: late.length ? 'var(--danger)' : undefined }}>
            {late.length}
          </div>
          {late.length ? <div className="dt down">Cần gọi vào ngay</div> : null}
        </div>
      </div>

      <div className="row" style={{ marginBottom: 12 }}>
        <label className="row" style={{ fontSize: 12.5, gap: 6 }}>
          <input
            type="checkbox"
            checked={includeFinished}
            onChange={(e) => setIncludeFinished(e.target.checked)}
          />
          Hiện cả khách đã xong
        </label>
        <button className="btn sec sm" style={{ marginLeft: 'auto' }} onClick={() => void load()}>
          Làm mới
        </button>
      </div>

      {loading ? (
        <div className="card">
          <Empty>Đang tải hàng đợi…</Empty>
        </div>
      ) : visits.length === 0 ? (
        <div className="card">
          <Empty>
            Chưa có khách nào check-in hôm nay.
            <br />
            Vào Lễ tân · Lịch hẹn, mở một lịch và bấm “Check-in (khách đã đến)”.
          </Empty>
        </div>
      ) : (
        <div className="grid queue-grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
          {visits.map((v) => {
            const isLate = v.status === 'WAITING' && v.waitingMinutes >= LATE_MINUTES
            const step = NEXT_STATUS[v.status]
            return (
              <div key={v.id} className={`queue-card${isLate ? ' late' : ''}`}>
                <div className="queue-no">{v.queueNumber}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="row" style={{ gap: 6 }}>
                    <b>{v.customer.name}</b>
                    <Tag style={tagStyleOf(VISIT_STATUS, v.status)} />
                  </div>
                  <div className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>
                    {v.customer.phone ?? '—'} · {v.customer.code}
                  </div>
                  <div style={{ fontSize: 12.5, marginTop: 4 }}>
                    {v.appointment?.title ?? v.purpose ?? 'Khách vãng lai'}
                    {v.appointment?.doctor ? ` · ${v.appointment.doctor.name}` : ''}
                  </div>
                  <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                    Đến lúc {hhmm(v.checkedInAt)} · chờ{' '}
                    <b style={{ color: isLate ? 'var(--danger)' : undefined }}>
                      {minutesLabel(v.waitingMinutes)}
                    </b>
                    {v.consultant ? ` · TV: ${v.consultant.name}` : ''}
                  </div>

                  <div className="row" style={{ marginTop: 8, flexWrap: 'wrap' }}>
                    {can('visit.update') && step ? (
                      <button className="btn sm" onClick={() => void advance(v)}>
                        {step.label}
                      </button>
                    ) : null}
                    <button
                      className="btn sec sm"
                      onClick={() => navigate(`/khach-hang/${v.customer.id}`)}
                    >
                      Mở hồ sơ
                    </button>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </>
  )
}

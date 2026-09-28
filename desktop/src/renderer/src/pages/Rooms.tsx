import React, { useCallback, useEffect, useState } from 'react'
import { createRoom, fetchRooms, getApiErrorMessage } from '../lib/api'
import { useAuth } from '../lib/auth-context'
import { Empty, Modal, useToast } from '../components/ui'
import type { Room } from '../lib/types'

/* PHÒNG & THIẾT BỊ — phòng quyết định lưới của cả màn Lịch hẹn lẫn Lịch mổ,
   nên đây là màn phải khai báo trước khi phòng khám chạy được. */

const ROOM_TYPE: Record<string, string> = {
  CONSULT: 'Phòng tư vấn',
  OPERATING: 'Phòng mổ',
  MINOR_OP: 'Phòng tiểu phẫu',
  TREATMENT: 'Phòng điều trị',
  RECOVERY: 'Phòng hồi sức'
}

export default function Rooms(): React.JSX.Element {
  const { can, branchId } = useAuth()
  const { say, fail } = useToast()

  const [rooms, setRooms] = useState<Room[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setRooms(await fetchRooms())
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [fail])

  useEffect(() => {
    void load()
  }, [load, branchId])

  const grouped = rooms.reduce<Record<string, Room[]>>((acc, r) => {
    ;(acc[r.type] ??= []).push(r)
    return acc
  }, {})

  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}>
        <span className="muted" style={{ fontSize: 12.5 }}>
          Phòng tư vấn hiện thành cột trong Lịch hẹn; phòng mổ và tiểu phẫu hiện thành cột trong Lịch mổ.
        </span>
        {can('settings.create') ? (
          <button className="btn" style={{ marginLeft: 'auto' }} onClick={() => setCreating(true)}>
            + Thêm phòng
          </button>
        ) : null}
      </div>

      {loading ? (
        <div className="card">
          <Empty>Đang tải…</Empty>
        </div>
      ) : rooms.length === 0 ? (
        <div className="card">
          <Empty>Cơ sở này chưa khai báo phòng nào.</Empty>
        </div>
      ) : (
        Object.entries(grouped).map(([type, list]) => (
          <div className="card" key={type} style={{ padding: 0, overflow: 'hidden', marginBottom: 12 }}>
            <div className="sec-title" style={{ padding: '12px 14px 0' }}>
              {ROOM_TYPE[type] ?? type} ({list.length})
            </div>
            <table>
              <thead>
                <tr>
                  <th>Mã</th>
                  <th>Tên phòng</th>
                  <th>Sức chứa</th>
                  <th>Trạng thái</th>
                </tr>
              </thead>
              <tbody>
                {list.map((r) => (
                  <tr key={r.id}>
                    <td className="muted">{r.code}</td>
                    <td>
                      <b>{r.name}</b>
                    </td>
                    <td>{r.capacity}</td>
                    <td>
                      {r.active ? (
                        <span className="tag" style={{ background: '#DCFCE7', color: '#15803D' }}>
                          Đang dùng
                        </span>
                      ) : (
                        <span className="tag out">Ngưng dùng</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))
      )}

      {creating ? (
        <NewRoomModal
          branchId={branchId ?? ''}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false)
            void load()
          }}
        />
      ) : null}
    </>
  )
}

function NewRoomModal({
  branchId,
  onClose,
  onCreated
}: {
  branchId: string
  onClose: () => void
  onCreated: () => void
}): React.JSX.Element {
  const { say, fail } = useToast()
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [type, setType] = useState('CONSULT')
  const [capacity, setCapacity] = useState(1)
  const [saving, setSaving] = useState(false)

  const submit = async (): Promise<void> => {
    if (!code || !name) {
      fail('Điền mã và tên phòng.')
      return
    }
    setSaving(true)
    try {
      await createRoom({ branchId, code: code.trim(), name: name.trim(), type, capacity })
      say('Đã thêm phòng.')
      onCreated()
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title="Thêm phòng"
      onClose={onClose}
      footer={
        <>
          <button className="btn sec" onClick={onClose}>
            Huỷ
          </button>
          <button className="btn" onClick={() => void submit()} disabled={saving}>
            {saving ? 'Đang lưu…' : 'Thêm'}
          </button>
        </>
      }
    >
      <div className="field">
        <label>Mã phòng *</label>
        <input className="input" value={code} onChange={(e) => setCode(e.target.value)} placeholder="PM1" />
      </div>
      <div className="field">
        <label>Tên phòng *</label>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Phòng mổ 1" />
      </div>
      <div className="field">
        <label>Loại phòng</label>
        <select className="input" value={type} onChange={(e) => setType(e.target.value)}>
          {Object.entries(ROOM_TYPE).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label>Sức chứa</label>
        <input
          className="input"
          type="number"
          value={capacity}
          onChange={(e) => setCapacity(Number(e.target.value))}
        />
      </div>
    </Modal>
  )
}

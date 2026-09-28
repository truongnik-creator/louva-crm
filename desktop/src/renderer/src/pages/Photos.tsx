import React, { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { fetchCustomers, fetchPhotoBlob, fetchPhotoSets, getApiErrorMessage } from '../lib/api'
import { useAuth } from '../lib/auth-context'
import { dateTimeVi } from '../lib/format'
import { PHOTO_STAGE_LABEL, initialOf } from '../lib/ui'
import { Empty, useToast } from '../components/ui'
import { PhotoUploadModal } from '../components/clinical-forms'
import type { CustomerListItem, PhotoSet } from '../lib/types'

/* ẢNH TRƯỚC - SAU — màn riêng của khối chuyên môn.
 *
 * Khác tab ảnh trong hồ sơ khách ở chỗ: đây là nơi SO SÁNH theo mốc. Chọn khách
 * ở cột trái, cột phải xếp ảnh theo mốc chuẩn (trước mổ · N1 · N7 · T1 · T3 · T6)
 * để bác sĩ nhìn được tiến triển mà không phải mở từng bộ.
 *
 * Ảnh không có URL tĩnh: mỗi tấm tải qua API có kiểm quyền rồi dựng blob. */

const STAGE_ORDER = ['PRE_OP', 'INTRA_OP', 'D1', 'D7', 'M1', 'M3', 'M6', 'OTHER']

export default function Photos(): React.JSX.Element {
  const { can, branchId } = useAuth()
  const { fail } = useToast()
  const navigate = useNavigate()

  const [customers, setCustomers] = useState<CustomerListItem[]>([])
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<CustomerListItem | null>(null)
  const [sets, setSets] = useState<PhotoSet[] | null>(null)
  const [uploading, setUploading] = useState(false)
  const [blocked, setBlocked] = useState(false)

  useEffect(() => {
    fetchCustomers({ q: query || undefined, limit: 100 })
      .then((r) => setCustomers(r.items))
      .catch((err) => fail(getApiErrorMessage(err)))
  }, [query, fail, branchId])

  const loadSets = useCallback(
    (customerId: string) => {
      setSets(null)
      setBlocked(false)
      fetchPhotoSets(customerId)
        .then(setSets)
        .catch(() => {
          setSets([])
          setBlocked(true)
        })
    },
    []
  )

  useEffect(() => {
    if (selected) loadSets(selected.id)
  }, [selected, loadSets])

  // Gom ảnh theo mốc để so sánh ngang.
  const byStage = new Map<string, PhotoSet[]>()
  for (const s of sets ?? []) {
    byStage.set(s.stage, [...(byStage.get(s.stage) ?? []), s])
  }

  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
      <div className="card" style={{ width: 290, flex: '0 0 290px', padding: 0, overflow: 'hidden' }}>
        <div style={{ padding: 12, borderBottom: '1px solid var(--border)' }}>
          <div className="sec-title">Chọn khách</div>
          <input
            className="input"
            placeholder="Tìm tên hoặc số điện thoại"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div style={{ maxHeight: '70vh', overflowY: 'auto' }}>
          {customers.length === 0 ? (
            <Empty>Không có khách nào.</Empty>
          ) : (
            customers.map((c) => (
              <div
                key={c.id}
                className={`zitem${selected?.id === c.id ? ' on' : ''}`}
                onClick={() => setSelected(c)}
              >
                <div className="ava">{initialOf(c.name)}</div>
                <div className="zmid">
                  <div className="ztop">
                    <b>{c.name}</b>
                  </div>
                  <div className="zprev">
                    {c.code} · {c.phone ?? '—'}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        {!selected ? (
          <div className="card">
            <Empty>
              Chọn một khách ở cột trái để xem ảnh theo mốc.
              <br />
              <span className="muted">
                Mốc chuẩn: trước mổ · trong mổ · N1 · N7 · T1 · T3 · T6
              </span>
            </Empty>
          </div>
        ) : (
          <>
            <div className="card" style={{ marginBottom: 12 }}>
              <div className="row">
                <div>
                  <b style={{ fontSize: 15 }}>{selected.name}</b>
                  <div className="muted" style={{ fontSize: 12.5 }}>
                    {selected.code} · {selected.phone ?? '—'}
                  </div>
                </div>
                <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                  <button className="btn sec sm" onClick={() => navigate(`/khach-hang/${selected.id}`)}>
                    Mở hồ sơ khách
                  </button>
                  {can('photo.create') ? (
                    <button className="btn sm" onClick={() => setUploading(true)}>
                      + Thêm ảnh
                    </button>
                  ) : null}
                </div>
              </div>
            </div>

            {sets === null ? (
              <div className="card">
                <Empty>Đang tải ảnh…</Empty>
              </div>
            ) : blocked ? (
              <div className="card">
                <Empty>
                  Bạn không đủ quyền xem ảnh của khách này, hoặc ảnh nằm ở cơ sở khác.
                </Empty>
              </div>
            ) : sets.length === 0 ? (
              <div className="card">
                <Empty>Khách chưa có ảnh nào.</Empty>
              </div>
            ) : (
              STAGE_ORDER.filter((st) => byStage.has(st)).map((st) => (
                <div className="card" key={st} style={{ marginBottom: 12 }}>
                  <div className="row" style={{ marginBottom: 9 }}>
                    <div className="sec-title" style={{ margin: 0 }}>
                      {PHOTO_STAGE_LABEL[st] ?? st}
                    </div>
                    <span className="muted" style={{ fontSize: 11.5, marginLeft: 'auto' }}>
                      {(byStage.get(st) ?? []).reduce((n, s) => n + s.photos.length, 0)} ảnh
                    </span>
                  </div>
                  {(byStage.get(st) ?? []).map((set) => (
                    <div key={set.id} style={{ marginBottom: 8 }}>
                      <div className="muted" style={{ fontSize: 11.5, marginBottom: 6 }}>
                        {dateTimeVi(set.takenAt)}
                        {set.takenBy ? ` · ${set.takenBy.name}` : ''}
                        {set.note ? ` · ${set.note}` : ''}
                      </div>
                      <div className="row" style={{ flexWrap: 'wrap' }}>
                        {set.photos.map((p) => (
                          <SecurePhoto key={p.id} photoId={p.id} fileName={p.fileName} />
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              ))
            )}
          </>
        )}
      </div>

      {uploading && selected ? (
        <PhotoUploadModal
          customerId={selected.id}
          onClose={() => setUploading(false)}
          onDone={() => {
            setUploading(false)
            loadSets(selected.id)
          }}
        />
      ) : null}
    </div>
  )
}

function SecurePhoto({ photoId, fileName }: { photoId: string; fileName: string }): React.JSX.Element {
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let objectUrl: string | null = null
    fetchPhotoBlob(photoId)
      .then((u) => {
        objectUrl = u
        setUrl(u)
      })
      .catch(() => setFailed(true))
    return () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [photoId])

  const box: React.CSSProperties = {
    width: 160,
    height: 160,
    borderRadius: 8,
    border: '1px solid var(--border)',
    display: 'grid',
    placeItems: 'center',
    background: 'var(--surface-2)'
  }

  if (failed) return <div style={box}><span className="muted" style={{ fontSize: 12 }}>Không tải được</span></div>
  if (!url) return <div style={box}><div className="spinner" /></div>
  return <img src={url} alt={fileName} style={{ ...box, objectFit: 'cover' }} />
}

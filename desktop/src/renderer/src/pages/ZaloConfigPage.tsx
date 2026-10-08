import React, { useCallback, useEffect, useState } from 'react'
import {
  discoverPancakeAgents,
  discoverPancakePages,
  fetchBranches,
  fetchChannels,
  fetchPancakeAgents,
  fetchPancakeConfigs,
  fetchStaff,
  fetchZaloAuthorizeUrl,
  fetchZaloConfigs,
  getApiErrorMessage,
  linkPancakeAgent,
  savePancakeConfig,
  saveZaloConfig,
  syncPancake,
  syncPancakeStats,
  updatePancakePage,
  type PancakeAgentConfigRow,
  type PancakeConfigRow
} from '../lib/api'
import { useAuth } from '../lib/auth-context'
import { dateTimeVi } from '../lib/format'
import { Empty, Modal, useToast } from '../components/ui'
import type { Branch, ZaloOAConfigView } from '../lib/types'

/* KẾT NỐI ZALO — nhiều Official Account, mỗi cơ sở một OA.
   App secret và token KHÔNG BAO GIỜ được trả về máy khách: server chỉ báo
   "đã cấu hình / chưa cấu hình". Muốn đổi thì nhập lại giá trị mới. */

export default function ZaloConfigPage(): React.JSX.Element {
  const [tab, setTab] = useState<'pancake' | 'zalo'>('pancake')

  return (
    <>
      <div className="tabs">
        <button className={tab === 'pancake' ? 'on' : ''} onClick={() => setTab('pancake')}>
          Pancake — Facebook · Instagram · TikTok · Zalo
        </button>
        <button className={tab === 'zalo' ? 'on' : ''} onClick={() => setTab('zalo')}>
          Zalo OA (nối thẳng)
        </button>
      </div>
      {tab === 'pancake' ? <PancakePanel /> : <ZaloPanel />}
    </>
  )
}

/* ------------------------------------------------------------- PANCAKE */

function PancakePanel(): React.JSX.Element {
  const { can } = useAuth()
  const { say, fail } = useToast()
  const [configs, setConfigs] = useState<PancakeConfigRow[]>([])
  const [channels, setChannels] = useState<Array<{ id: string; name: string }>>([])
  const [editing, setEditing] = useState<PancakeConfigRow | 'new' | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [c, ch] = await Promise.all([fetchPancakeConfigs(), fetchChannels().catch(() => [])])
      setConfigs(c)
      setChannels(ch)
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [fail])

  useEffect(() => {
    void load()
  }, [load])

  const discover = async (id: string): Promise<void> => {
    setBusy(id)
    try {
      const r = await discoverPancakePages(id)
      say(`Tìm thấy ${r.found} trang, thêm mới ${r.created}.`)
      void load()
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setBusy(null)
    }
  }

  const syncStats = async (id: string): Promise<void> => {
    setBusy(id)
    try {
      const r = await syncPancakeStats(id)
      say(
        r.started
          ? 'Đã bắt đầu kéo thống kê hiệu suất chạy nền. Xem kết quả ở Đo lường › Hiệu suất Pancake sau ít phút.'
          : 'Đang có một lượt kéo thống kê chạy nền, chờ lượt đó xong.'
      )
      window.setTimeout(() => void load(), 5000)
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setBusy(null)
    }
  }

  const sync = async (id: string): Promise<void> => {
    setBusy(id)
    try {
      const r = await syncPancake(id)
      say(
        r.started
          ? 'Đã bắt đầu đồng bộ chạy nền. Kết quả hiện ở cột ghi chú sau ít phút (bấm tải lại).'
          : 'Đang có một lượt đồng bộ chạy nền, chờ lượt đó xong.'
      )
      window.setTimeout(() => void load(), 5000)
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <div className="alert wr">
        <b>Vì sao đi qua Pancake:</b> TikTok không có API nhắn tin công khai — nối thẳng là bất khả thi.
        Facebook và Instagram nối thẳng được nhưng phải chờ Meta duyệt 2–6 tuần. Pancake gom sẵn cả bốn
        kênh, và phòng khám đã dùng sẵn cho các trang Facebook hiện có.
      </div>

      <div className="alert ok">
        <b>Nhận tin thời gian thực (webhook):</b> khai báo trong Pancake địa chỉ{' '}
        <code>https://&lt;tên-miền&gt;/api/pancake/webhook</code> kèm bí mật webhook (ô Bí mật webhook của kết nối, hoặc
        biến PANCAKE_WEBHOOK_SECRET trên máy chủ). Nút Đồng bộ chỉ là dự phòng khi webhook rớt, chạy nền. Trả lời hội thoại
        nguồn Pancake luôn gửi qua Pancake.
      </div>

      <div className="row" style={{ marginBottom: 12 }}>
        <span className="muted" style={{ fontSize: 12.5 }}>
          Gắn mỗi trang vào một “nguồn khách” để tin nhắn nối được với chi phí quảng cáo khi tính ROAS.
        </span>
        <button className="btn sec sm" style={{ marginLeft: 'auto' }} onClick={() => void load()}>
          Làm mới
        </button>
        {can('settings.update') ? (
          <button className="btn" onClick={() => setEditing('new')}>
            + Kết nối Pancake
          </button>
        ) : null}
      </div>

      {loading ? (
        <div className="card">
          <Empty>Đang tải…</Empty>
        </div>
      ) : configs.length === 0 ? (
        <div className="card">
          <Empty>
            Chưa kết nối Pancake.
            <br />
            <span className="muted">
              Lấy API token trong Pancake: Cấu hình › Ứng dụng › API, rồi bấm “+ Kết nối Pancake”.
            </span>
          </Empty>
        </div>
      ) : (
        configs.map((c) => (
          <div className="card" key={c.id} style={{ marginBottom: 12 }}>
            <div className="row" style={{ marginBottom: 10 }}>
              <div>
                <b style={{ fontSize: 15 }}>{c.label}</b>
                <div className="muted" style={{ fontSize: 12 }}>
                  {c.connected ? 'Đã có token' : 'Chưa có token'}
                  {c.lastSyncAt ? ` · đồng bộ lần cuối ${dateTimeVi(c.lastSyncAt)}` : ' · chưa đồng bộ'}
                </div>
                {c.lastSyncNote ? (
                  <div className="muted" style={{ fontSize: 11.5 }}>
                    {c.lastSyncNote}
                  </div>
                ) : null}
              </div>
              {can('settings.update') ? (
                <div className="row" style={{ marginLeft: 'auto', gap: 6 }}>
                  <button className="btn sec sm" onClick={() => setEditing(c)}>
                    Sửa
                  </button>
                  <button className="btn sec sm" disabled={busy === c.id} onClick={() => void discover(c.id)}>
                    Dò trang
                  </button>
                  <button className="btn sec sm" disabled={busy === c.id} onClick={() => void syncStats(c.id)}>
                    Kéo thống kê
                  </button>
                  <button className="btn sm" disabled={busy === c.id} onClick={() => void sync(c.id)}>
                    {busy === c.id ? 'Đang chạy…' : 'Đồng bộ ngay'}
                  </button>
                </div>
              ) : null}
            </div>

            {c.pages.length === 0 ? (
              <Empty>Chưa dò được trang nào. Bấm “Dò trang”.</Empty>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Trang</th>
                    <th>Nền tảng</th>
                    <th>ID Pancake</th>
                    <th>Nguồn khách (để tính ROAS)</th>
                    <th>Token trang</th>
                    <th>Đồng bộ lần cuối</th>
                    <th>Kéo thống kê</th>
                  </tr>
                </thead>
                <tbody>
                  {c.pages.map((p) => (
                    <tr key={p.id}>
                      <td>
                        <b>{p.name}</b>
                      </td>
                      <td>
                        <span className="tag out">{p.platform}</span>
                      </td>
                      <td className="muted">{p.pageId}</td>
                      <td>
                        {can('settings.update') ? (
                          <select
                            className="input"
                            style={{ width: 180 }}
                            value={p.channel?.id ?? ''}
                            onChange={async (e) => {
                              try {
                                await updatePancakePage(p.id, { channelId: e.target.value || null })
                                say('Đã gắn nguồn khách.')
                                void load()
                              } catch (err) {
                                fail(getApiErrorMessage(err))
                              }
                            }}
                          >
                            <option value="">— chưa gắn —</option>
                            {channels.map((ch) => (
                              <option key={ch.id} value={ch.id}>
                                {ch.name}
                              </option>
                            ))}
                          </select>
                        ) : (
                          (p.channel?.name ?? '—')
                        )}
                      </td>
                      <td>
                        {p.hasPageToken ? (
                          <span className="tag ok">đã có</span>
                        ) : can('settings.update') ? (
                          <button
                            className="btn sec sm"
                            onClick={async () => {
                              const token = window.prompt(
                                'Dán Page Access Token của trang (Pancake: Cài đặt trang › Công cụ).\nĐể trống thì hệ thống tự sinh từ API token của kết nối khi cần.'
                              )
                              if (!token?.trim()) return
                              try {
                                await updatePancakePage(p.id, { pageAccessToken: token.trim() })
                                say('Đã lưu token trang.')
                                void load()
                              } catch (err) {
                                fail(getApiErrorMessage(err))
                              }
                            }}
                          >
                            Dán token
                          </button>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td className="muted">{p.lastSyncAt ? dateTimeVi(p.lastSyncAt) : '—'}</td>
                      <td className="muted">{p.statsSyncAt ? dateTimeVi(p.statsSyncAt) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            <PancakeAgentsBlock configId={c.id} />
          </div>
        ))
      )}

      {editing ? (
        <PancakeModal
          config={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            void load()
          }}
        />
      ) : null}
    </>
  )
}

/**
 * F35: nhân viên bên Pancake và tài khoản CRM tương ứng.
 *
 * Vì sao phải gắn: báo cáo hiệu suất lấy số từ Pancake, mà Pancake chỉ biết
 * "user Pancake" của nó. Chưa gắn thì vẫn xem được theo tên Pancake, nhưng số
 * đó không nối được vào bảng lương, bảng thi đua của CRM.
 */
function PancakeAgentsBlock({ configId }: { configId: string }): React.JSX.Element {
  const { can } = useAuth()
  const { say, fail } = useToast()
  const [open, setOpen] = useState(false)
  const [agents, setAgents] = useState<PancakeAgentConfigRow[]>([])
  const [staff, setStaff] = useState<Array<{ id: string; name: string }>>([])
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const [a, s] = await Promise.all([
        fetchPancakeAgents(configId),
        fetchStaff({ status: 'ACTIVE' }).catch(() => [])
      ])
      setAgents(a)
      setStaff(s.map((u) => ({ id: u.id, name: u.name })))
    } catch (err) {
      fail(getApiErrorMessage(err))
    }
  }, [configId, fail])

  useEffect(() => {
    if (open) void load()
  }, [open, load])

  const discover = async (): Promise<void> => {
    setBusy(true)
    try {
      const r = await discoverPancakeAgents(configId)
      say(
        r.errors.length
          ? `Tìm thấy ${r.found} nhân viên. Lỗi: ${r.errors.join(' | ')}`
          : `Tìm thấy ${r.found} nhân viên. Tên khớp duy nhất đã được gắn tự động.`
      )
      void load()
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  if (!open) {
    return (
      <div className="row" style={{ marginTop: 10 }}>
        <button className="btn sec sm" onClick={() => setOpen(true)}>
          Nhân viên Pancake (gắn với tài khoản CRM)
        </button>
      </div>
    )
  }

  return (
    <div style={{ marginTop: 12, borderTop: '1px solid var(--bd, #e5e7eb)', paddingTop: 10 }}>
      <div className="row" style={{ marginBottom: 8 }}>
        <b>Nhân viên Pancake</b>
        <span className="muted" style={{ fontSize: 12, marginLeft: 8 }}>
          Gắn để số tin và tốc độ phản hồi quy về đúng người trong CRM
        </span>
        <div className="row" style={{ marginLeft: 'auto', gap: 6 }}>
          {can('settings.update') ? (
            <button className="btn sec sm" disabled={busy} onClick={() => void discover()}>
              {busy ? 'Đang dò…' : 'Dò nhân viên'}
            </button>
          ) : null}
          <button className="btn sec sm" onClick={() => setOpen(false)}>
            Ẩn
          </button>
        </div>
      </div>

      {agents.length === 0 ? (
        <Empty>
          Chưa dò được nhân viên nào. Bấm “Dò nhân viên”.
          <br />
          <span className="muted">Cần có trang đã dò và token trang hợp lệ.</span>
        </Empty>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Tên trên Pancake</th>
              <th>Trạng thái</th>
              <th>Tài khoản CRM</th>
            </tr>
          </thead>
          <tbody>
            {agents.map((a) => (
              <tr key={a.id}>
                <td>
                  <b>{a.name}</b>
                </td>
                <td>{a.active ? <span className="tag ok">đang dùng</span> : <span className="tag">đã tắt</span>}</td>
                <td>
                  {can('settings.update') ? (
                    <select
                      className="input"
                      style={{ width: 220 }}
                      value={a.userId ?? ''}
                      onChange={async (e) => {
                        try {
                          await linkPancakeAgent(a.id, e.target.value || null)
                          say('Đã cập nhật.')
                          void load()
                        } catch (err) {
                          fail(getApiErrorMessage(err))
                        }
                      }}
                    >
                      <option value="">— chưa gắn —</option>
                      {staff.map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.name}
                        </option>
                      ))}
                    </select>
                  ) : (
                    (a.user?.name ?? '—')
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

function PancakeModal({
  config,
  onClose,
  onSaved
}: {
  config: PancakeConfigRow | null
  onClose: () => void
  onSaved: () => void
}): React.JSX.Element {
  const { say, fail } = useToast()
  const [label, setLabel] = useState(config?.label ?? 'Pancake Louva')
  const [accessToken, setAccessToken] = useState('')
  const [pcWebhookSecret, setPcWebhookSecret] = useState('')
  const [saving, setSaving] = useState(false)

  const submit = async (): Promise<void> => {
    if (!config && !accessToken) {
      fail('Cần API token Pancake.')
      return
    }
    setSaving(true)
    try {
      await savePancakeConfig({
        id: config?.id,
        label,
        accessToken: accessToken || undefined,
        webhookSecret: pcWebhookSecret || undefined
      })
      say('Đã lưu kết nối Pancake. Bấm “Dò trang” để nạp danh sách trang.')
      onSaved()
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title={config ? `Sửa — ${config.label}` : 'Kết nối Pancake'}
      onClose={onClose}
      footer={
        <>
          <button className="btn sec" onClick={onClose}>
            Huỷ
          </button>
          <button className="btn" onClick={() => void submit()} disabled={saving}>
            {saving ? 'Đang lưu…' : 'Lưu'}
          </button>
        </>
      }
    >
      <div className="field">
        <label>Tên hiển thị</label>
        <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} />
      </div>
      <div className="field">
        <label>API token Pancake {config ? '(để trống nếu không đổi)' : '*'}</label>
        <input
          className="input"
          type="password"
          value={accessToken}
          onChange={(e) => setAccessToken(e.target.value)}
          placeholder={config ? '••••••••' : ''}
        />
      </div>
      <div className="field">
        <label>Bí mật webhook (để trống nếu không đổi)</label>
        <input
          className="input"
          type="password"
          value={pcWebhookSecret}
          onChange={(e) => setPcWebhookSecret(e.target.value)}
          placeholder="Chuỗi bí mật khai cùng ở Pancake"
        />
      </div>
      <div className="muted" style={{ fontSize: 11.5 }}>
        Token được mã hoá AES-256-GCM khi lưu và không bao giờ gửi ngược về máy khách. Token này mở được
        toàn bộ hội thoại khách — đối xử với nó như mật khẩu.
      </div>
    </Modal>
  )
}

/* ------------------------------------------------------------- ZALO OA */

function ZaloPanel(): React.JSX.Element {
  const { can } = useAuth()
  const { say, fail } = useToast()

  const [configs, setConfigs] = useState<ZaloOAConfigView[]>([])
  const [branches, setBranches] = useState<Branch[]>([])
  const [editing, setEditing] = useState<ZaloOAConfigView | 'new' | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [rows, branchRows] = await Promise.all([fetchZaloConfigs(), fetchBranches()])
      setConfigs(rows)
      setBranches(branchRows)
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [fail])

  useEffect(() => {
    void load()
  }, [load])

  const connect = async (config: ZaloOAConfigView): Promise<void> => {
    try {
      const url = await fetchZaloAuthorizeUrl(config.id)
      await window.crm.openExternal(url)
      say('Đã mở trang cấp quyền Zalo trong trình duyệt. Cấp quyền xong hãy bấm Làm mới.')
    } catch (err) {
      fail(getApiErrorMessage(err))
    }
  }

  return (
    <>
      <div className="alert wr">
        Webhook Zalo phải trỏ tới một địa chỉ công khai. Khi chạy trên máy cá nhân, Zalo không gọi vào
        được — hộp thư vẫn hoạt động nhưng chỉ với dữ liệu nhập trong hệ thống. Đưa máy chủ lên tên miền
        thật rồi khai báo webhook <code>https://&lt;tên-miền&gt;/api/zalo/webhook</code>.
      </div>

      <div className="row" style={{ marginBottom: 12 }}>
        <span className="muted" style={{ fontSize: 12.5 }}>
          Mỗi cơ sở dùng một Official Account riêng — hội thoại tự gắn vào đúng cơ sở của OA.
        </span>
        <button className="btn sec sm" onClick={() => void load()}>
          Làm mới
        </button>
        {can('settings.update') ? (
          <button className="btn" onClick={() => setEditing('new')}>
            + Thêm Official Account
          </button>
        ) : null}
      </div>

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        {loading ? (
          <Empty>Đang tải…</Empty>
        ) : configs.length === 0 ? (
          <Empty>
            Chưa cấu hình Official Account nào.
            <br />
            Hệ thống vẫn chạy bình thường — chỉ là chưa nhận và gửi được tin Zalo.
          </Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Tên</th>
                <th>OA ID</th>
                <th>App ID</th>
                <th>Cơ sở</th>
                <th>Kết nối</th>
                <th>Token hết hạn</th>
                <th>Webhook secret</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {configs.map((c) => (
                <tr key={c.id}>
                  <td>
                    <b>{c.label}</b>
                  </td>
                  <td className="muted">{c.oaId}</td>
                  <td className="muted">{c.appId}</td>
                  <td>{c.branch?.name ?? <span className="muted">Dùng chung</span>}</td>
                  <td>
                    {c.connected ? (
                      <span className="tag" style={{ background: '#DCFCE7', color: '#15803D' }}>
                        Đã kết nối
                      </span>
                    ) : (
                      <span className="tag" style={{ background: '#FEE2E2', color: '#B91C1C' }}>
                        Chưa kết nối
                      </span>
                    )}
                  </td>
                  <td className="muted">{c.tokenExpiresAt ? dateTimeVi(c.tokenExpiresAt) : '—'}</td>
                  <td>
                    {c.hasWebhookSecret ? (
                      <span className="tag out">Đã đặt</span>
                    ) : (
                      <span className="muted">Chưa đặt</span>
                    )}
                  </td>
                  <td>
                    {can('settings.update') ? (
                      <div className="row" style={{ gap: 4 }}>
                        <button className="btn sec sm" onClick={() => setEditing(c)}>
                          Sửa
                        </button>
                        <button className="btn sm" onClick={() => void connect(c)}>
                          {c.connected ? 'Kết nối lại' : 'Kết nối'}
                        </button>
                      </div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="muted" style={{ fontSize: 12, marginTop: 9 }}>
        App secret và token được mã hoá AES-256-GCM khi lưu, và không bao giờ được gửi ngược về máy khách.
      </div>

      {editing ? (
        <ConfigModal
          config={editing === 'new' ? null : editing}
          branches={branches}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            void load()
          }}
        />
      ) : null}
    </>
  )
}

function ConfigModal({
  config,
  branches,
  onClose,
  onSaved
}: {
  config: ZaloOAConfigView | null
  branches: Branch[]
  onClose: () => void
  onSaved: () => void
}): React.JSX.Element {
  const { say, fail } = useToast()
  const [label, setLabel] = useState(config?.label ?? '')
  const [oaId, setOaId] = useState(config?.oaId ?? '')
  const [appId, setAppId] = useState(config?.appId ?? '')
  const [appSecret, setAppSecret] = useState('')
  const [webhookSecret, setWebhookSecret] = useState('')
  const [branchId, setBranchId] = useState(config?.branch?.id ?? '')
  const [saving, setSaving] = useState(false)

  const submit = async (): Promise<void> => {
    if (!label || !oaId || !appId) {
      fail('Điền đủ tên, OA ID và App ID.')
      return
    }
    if (!config && !appSecret) {
      fail('App secret bắt buộc khi thêm mới.')
      return
    }
    setSaving(true)
    try {
      await saveZaloConfig({
        id: config?.id,
        label,
        oaId,
        appId,
        appSecret: appSecret || undefined,
        webhookSecret: webhookSecret || undefined,
        branchId: branchId || null
      })
      say('Đã lưu cấu hình Official Account.')
      onSaved()
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title={config ? `Sửa — ${config.label}` : 'Thêm Official Account'}
      onClose={onClose}
      footer={
        <>
          <button className="btn sec" onClick={onClose}>
            Huỷ
          </button>
          <button className="btn" onClick={() => void submit()} disabled={saving}>
            {saving ? 'Đang lưu…' : 'Lưu'}
          </button>
        </>
      }
    >
      <div className="field">
        <label>Tên hiển thị *</label>
        <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} />
      </div>
      <div className="field">
        <label>OA ID *</label>
        <input className="input" value={oaId} onChange={(e) => setOaId(e.target.value)} />
      </div>
      <div className="field">
        <label>App ID *</label>
        <input className="input" value={appId} onChange={(e) => setAppId(e.target.value)} />
      </div>
      <div className="field">
        <label>
          App secret {config ? '(để trống nếu không đổi)' : '*'}
        </label>
        <input
          className="input"
          type="password"
          value={appSecret}
          onChange={(e) => setAppSecret(e.target.value)}
          placeholder={config ? '••••••••' : ''}
        />
      </div>
      <div className="field">
        <label>Webhook secret (để trống nếu không đổi)</label>
        <input
          className="input"
          type="password"
          value={webhookSecret}
          onChange={(e) => setWebhookSecret(e.target.value)}
        />
      </div>
      <div className="field">
        <label>Cơ sở sử dụng OA này</label>
        <select className="input" value={branchId} onChange={(e) => setBranchId(e.target.value)}>
          <option value="">— Dùng chung toàn công ty —</option>
          {branches.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
      </div>
    </Modal>
  )
}

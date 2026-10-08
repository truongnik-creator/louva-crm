import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { useAuth } from './auth-context'
import { fetchClinicConfig, type ClinicConfig, type StageDef } from './api-nova'
import { stageStyle as legacyStageStyle, type TagStyle } from './ui'

/* F6: cấu hình phòng khám (chế độ tiêm hoặc phẫu thuật) cho toàn giao diện:
   bộ bước của khách, lý do mất khách, nhãn thuật ngữ, ẩn menu phẫu thuật. */

const FALLBACK: ClinicConfig = {
  mode: 'INJECTION',
  name: '',
  stages: [],
  allStages: [],
  lostReasons: [],
  terms: { medicalRecord: 'Hồ sơ điều trị', postOp: 'Chăm sóc sau tiêm', procedure: 'Ca thực hiện', procedures: 'Ca thực hiện' },
  photoStages: [],
  ai: { configured: false, extractEnabled: false },
  deposit: { defaultAmount: 0 }
}

interface ClinicContextValue extends ClinicConfig {
  loaded: boolean
  isInjection: boolean
  reload: () => Promise<void>
  stageStyle: (key: string | null | undefined) => TagStyle
  lostStage: StageDef | undefined
  term: (key: string, fallback: string) => string
  lostReasonLabel: (key: string | null | undefined) => string
}

const ClinicContext = createContext<ClinicContextValue | undefined>(undefined)

export function ClinicProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const { user } = useAuth()
  const [config, setConfig] = useState<ClinicConfig>(FALLBACK)
  const [loaded, setLoaded] = useState(false)

  const reload = useCallback(async () => {
    try {
      setConfig(await fetchClinicConfig())
    } catch {
      setConfig(FALLBACK)
    } finally {
      setLoaded(true)
    }
  }, [])

  useEffect(() => {
    if (user) void reload()
    else setLoaded(false)
  }, [user, reload])

  const value = useMemo<ClinicContextValue>(() => {
    const byKey = new Map(config.allStages.map((s) => [s.key, s]))
    return {
      ...config,
      loaded,
      isInjection: config.mode === 'INJECTION',
      reload,
      stageStyle: (key) => {
        const s = key ? byKey.get(key) : undefined
        return s ? { t: s.label, bg: s.bg, fg: s.fg } : legacyStageStyle(key)
      },
      lostStage: config.stages.find((s) => s.lost),
      term: (key, fallback) => config.terms[key] ?? fallback,
      lostReasonLabel: (key) => config.lostReasons.find((r) => r.key === key)?.label ?? key ?? ''
    }
  }, [config, loaded, reload])

  return <ClinicContext.Provider value={value}>{children}</ClinicContext.Provider>
}

export function useClinic(): ClinicContextValue {
  const ctx = useContext(ClinicContext)
  if (!ctx) throw new Error('useClinic phải nằm trong ClinicProvider')
  return ctx
}

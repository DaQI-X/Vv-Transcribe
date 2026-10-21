/**
 * 开屏加载页
 * 白色背景 + 居中 Logo 擦除揭示动画，等待词典/ASR 等前置服务就绪后缩小淡出
 * 底部一行阶段文案如实反映主进程进度，不编造百分比
 */
import { useEffect, useState } from 'react'
import logoImage from '@/assets/public/lottie/Vv Transcribe Open.png'

interface SplashScreenProps {
  visible: boolean
  /** 就绪前主进程反馈的初始化阶段，如「正在启动转写引擎」 */
  phase?: string
}

export function SplashScreen({ visible, phase }: SplashScreenProps) {
  const [mounted, setMounted] = useState(true)
  const [exiting, setExiting] = useState(false)

  useEffect(() => {
    if (!visible && mounted && !exiting) {
      setExiting(true)
      const timer = setTimeout(() => setMounted(false), 600)
      return () => clearTimeout(timer)
    }
  }, [visible, mounted, exiting])

  if (!mounted) return null

  return (
    <div
      className="splash-screen"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        backgroundColor: 'var(--bg-page)',
        transition: 'opacity 0.5s ease-out',
        opacity: exiting ? 0 : 1,
        pointerEvents: exiting ? 'none' : 'auto',
      }}
    >
      <div
        style={{
          width: 700,
          height: 700,
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          alignItems: 'center',
          gap: 4,
          transform: exiting ? 'scale(0.3)' : 'scale(1)',
          transition: 'transform 0.5s cubic-bezier(0.4, 0, 0.2, 1)',
        }}
      >
        <div style={{ position: 'relative', width: 620, height: 400 }}>
          <img
            src={logoImage}
            alt="Vv Transcribe Logo"
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'contain',
              clipPath: 'inset(0 100% 0 0)',
              animation: 'wipeReveal 2s cubic-bezier(0.25, 0.46, 0.45, 0.94) 0.3s forwards',
            }}
          />
        </div>
        <div
          style={{
            fontSize: 13,
            lineHeight: '20px',
            color: 'var(--text-muted)',
            // Logo PNG 渲染成 400px 高后，标志下方还有约 110px 透明留白，不抵消文案会离标志太远
            marginTop: -90,
            opacity: exiting ? 0 : 1,
            transition: 'opacity 0.3s ease-out',
          }}
        >
          {phase ?? '正在启动'}
        </div>
      </div>
      <style>{`
        @keyframes wipeReveal {
          0% { clip-path: inset(0 100% 0 0); }
          100% { clip-path: inset(0 0% 0 0); }
        }
      `}</style>
    </div>
  )
}

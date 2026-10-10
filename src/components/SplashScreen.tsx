/**
 * 开屏加载页
 * 白色背景 + 居中 Logo 擦除揭示动画，等待词典/ASR 等前置服务就绪后淡出
 */
import { useEffect, useState } from 'react'
import logoImage from '@/assets/public/lottie/Vv Transcribe Open.png'

interface SplashScreenProps {
  visible: boolean
}

export function SplashScreen({ visible }: SplashScreenProps) {
  const [mounted, setMounted] = useState(true)

  useEffect(() => {
    if (!visible) {
      const timer = setTimeout(() => setMounted(false), 600)
      return () => clearTimeout(timer)
    }
  }, [visible])

  if (!mounted) return null

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        backgroundColor: '#fff',
        transition: 'opacity 0.5s ease-out',
        opacity: visible ? 1 : 0,
        pointerEvents: visible ? 'auto' : 'none',
      }}
    >
      <div style={{ width: 700, height: 700, position: 'relative', display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
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

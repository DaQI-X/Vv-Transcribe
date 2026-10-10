/**
 * 服务初始化错误页
 * 当词典/ASR 等前置服务加载失败时展示，提示用户重启应用
 */
interface ErrorPageProps {
  message: string
}

export function ErrorPage({ message }: ErrorPageProps) {
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: '#fff',
        color: '#333',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        padding: 40,
        textAlign: 'center',
      }}
    >
      <div style={{ fontSize: 48, marginBottom: 16 }}>️</div>
      <h1 style={{ fontSize: 22, fontWeight: 600, marginBottom: 12, color: '#1a1a1a' }}>
        服务初始化失败
      </h1>
      <p style={{ fontSize: 15, color: '#666', maxWidth: 400, lineHeight: 1.6, marginBottom: 24 }}>
        {message}
      </p>
      <p style={{ fontSize: 13, color: '#999' }}>
        请关闭应用后重新打开
      </p>
    </div>
  )
}

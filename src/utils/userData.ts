/**
 * 本机数据目录（userData）
 * settings.json、按需下载的配音引擎与组件都住在这里。设置没能读出来时，
 * 这是用户唯一能自己看一眼原件（以及 corrupt 留档那份、上一次的 .bak）的入口。
 */
import { getElectronAPI } from '@/hooks/useElectronAPI'
import { toast } from '@/components/ui/Toast'

/**
 * 三个地方都要用它（设置页的按钮、保存失败的 toast、启动时的提示），所以留一处实现：
 * 主进程那句提示里点名的就是「打开数据目录」，措辞不一致会让人在界面上找不到那个按钮。
 */
export async function openUserDataDirectory(): Promise<void> {
  const api = getElectronAPI()
  if (!api) return
  try {
    const result = await api.openUserDataDirectory()
    if (!result.success) {
      toast.error(`打开数据目录失败：${result.error || '未知原因'}`)
    }
  } catch {
    toast.error('打开数据目录失败')
  }
}

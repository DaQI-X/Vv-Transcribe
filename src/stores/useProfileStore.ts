/**
 * 三档能力（转写 / 校对 / 配音）共用的「配置方案」状态（#222 第④步）
 *
 * 为什么不各页面各存一份：这一格做的事只有一个口径——同一条 `settings:setDefaultProfile`、
 * 同一句成功提示、同一套失败话术。写进页面就是几份，改一句话要记得改几处，那种东西一定漂移。
 * 现在真按它切换的只有校对弹窗和配音页两处（转写首页那条下拉在 #222 重写第③步撤了，
 * 那一档的「当前使用」改到设置表单里那颗勾选，走 `settings:save`）；asr 那一份 slice
 * 仍然跟着 `listProfiles` 一起刷，因为一次读回来的就是三档，拆开存反而是两份真相。
 *
 * 三条口径：
 * - 切的是「当前使用」这条**长期**选择，不是单次覆盖：改的是磁盘上的 `defaultProfileId`，
 *   正在跑的活用的还是开跑时读好的那套。所以下一页的禁用条件由页面自己给（它才知道有没有在跑），
 *   话术里不许出现「立刻生效」。
 * - 列表读不出来留 null，界面整块收起。不许演成「一条都没有」：那句话会把用户已有的方案说成不存在。
 * - 只有一条时同样收起——没有可切的第二套，建方案是设置页的事。
 * - 单次参数（配音的模型/音色、转写的语言覆盖）不在这里，那些是各页自己的状态。
 */
import { create } from 'zustand'
import { getElectronAPI } from '@/hooks/useElectronAPI'
import { toast } from '@/components/ui/Toast'
import { CAPABILITY_NOUN } from '@/components/settings/ProfileBar'
import type { ProfileCapability, ProfileView, ProfilesView } from '@/types/settingsProfile'

const CAPABILITIES: readonly ProfileCapability[] = ['asr', 'ai', 'tts']

/** error 为 null 却没有列表＝IPC 传输本身挂了，这次到底改没改成都不知道，不许报成功 */
const UNCERTAIN = '这次切换没能确认。重开这一页，再看用的是哪一套'

export interface ProfileSlice {
  /** null＝这次没读出来 */
  profiles: ProfileView[] | null
  /** 该档「当前使用」那条的 id（磁盘上的 `defaultProfileId`） */
  profileId: string
}

interface ProfileStoreState {
  slice: Record<ProfileCapability, ProfileSlice>
  /** 每档一个在途标记：连点两次会发两次「设为当前使用」，这期间下拉要禁掉 */
  switching: Record<ProfileCapability, boolean>
  /** 一次 `listProfiles` 就给全三档，所以不接 capability 参数：谁进来都读同一份磁盘状态 */
  load: () => Promise<void>
  /** 把磁盘此刻的样子落回界面；null＝这次没读出来，三档一起收成「看不见」 */
  applyView: (view: ProfilesView | null) => void
  /** 返回值给调用方决定要不要接着做本档的收尾（配音那条要清空单次参数并重读设置） */
  setProfile: (capability: ProfileCapability, profileId: string) => Promise<boolean>
}

/**
 * 这一档到底长不长得成一行控件：只在「确实有第二套可换」时长出来。
 * 下拉自己和旁边那句话（配音页那条档位横幅）共用这同一个判断，不许两处各算一次。
 */
export function switchableProfiles(profiles: ProfileView[] | null): ProfileView[] | null {
  return profiles && profiles.length > 1 ? profiles : null
}

const emptySlice = (): ProfileSlice => ({ profiles: null, profileId: '' })

export const useProfileStore = create<ProfileStoreState>((set, get) => ({
  slice: { asr: emptySlice(), ai: emptySlice(), tts: emptySlice() },
  switching: { asr: false, ai: false, tts: false },

  load: async () => {
    const api = getElectronAPI()
    if (!api) return
    // 读失败回 null（IPC 收口后不再 reject，见 ipc/guard.ts）：那正是上面第二条口径要的样子
    get().applyView(await api.listProfiles().catch(() => null))
  },

  applyView: (view) => {
    const next = {} as Record<ProfileCapability, ProfileSlice>
    for (const capability of CAPABILITIES) {
      next[capability] = view
        ? { profiles: view.profiles[capability], profileId: view.defaultProfileId[capability] }
        : emptySlice()
    }
    set({ slice: next })
  },

  setProfile: async (capability, profileId) => {
    if (get().switching[capability]) return false
    const target = (get().slice[capability].profiles ?? []).find(
      (profile) => profile.id === profileId
    )
    // 列表是进这一页时缓存的那份，别处（设置窗口）刚删掉这条时它还在：
    // 拿一个已经不存在的 id 去发「设为当前使用」，主进程会照实报错，界面就不自己编一句
    if (!target) {
      toast.error('这条方案已经不在列表里了，重开这一页再看一次', 12000)
      return false
    }
    const api = getElectronAPI()
    if (!api) return false
    set({ switching: { ...get().switching, [capability]: true } })
    try {
      const result = await api.setDefaultProfile(capability, profileId)
      if (result?.error) {
        toast.error(result.error, 12000)
        return false
      }
      if (!result?.profiles) {
        toast.error(UNCERTAIN, 12000)
        return false
      }
      get().applyView(result.profiles)
      const noun = CAPABILITY_NOUN[capability]
      // 这一句和设置页那颗「设为当前使用」是同一套话：说的都是长期选择换了哪条
      toast.success(
        `已把「${target.name}」设为当前使用的${noun}配置，下一次${noun}就按这套干活`,
        8000
      )
      return true
    } catch {
      // 正常走不到（IPC 都收在 guard 里）；真走到就是通道本身炸了，也要说得出「没改成」
      toast.error(UNCERTAIN, 12000)
      return false
    } finally {
      set({ switching: { ...get().switching, [capability]: false } })
    }
  },
}))

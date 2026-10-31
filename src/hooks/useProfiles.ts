/**
 * 这一页那一档的方案列表（#222 第④步）：挂载时重读一次磁盘。
 *
 * 读为什么放在页面这一层、不放在下拉组件里：下拉在「只有一套 / 读不出来」时是不挂载的，
 * 让挂载决定读不读就成了先有鸡还是先有蛋——不读就一直看不见，永远长不出第二套来选。
 */
import { useEffect } from 'react'
import { useProfileStore, type ProfileSlice } from '@/stores/useProfileStore'
import type { ProfileCapability } from '@/types/settingsProfile'

export interface UseProfilesResult extends ProfileSlice {
  /** 这一档的切换在途：下拉在此期间要禁掉，连点会发两次「设为当前使用」 */
  switching: boolean
}

export function useProfiles(capability: ProfileCapability): UseProfilesResult {
  const slice = useProfileStore((s) => s.slice[capability])
  const switching = useProfileStore((s) => s.switching[capability])
  useEffect(() => {
    void useProfileStore.getState().load()
  }, [])
  return { ...slice, switching }
}

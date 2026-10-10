/**
 * 播放器状态管理（Zustand）
 * 管理播放/暂停、当前时间、时长、倍速、当前高亮段落、跳转目标等状态
 * 用于 AudioPlayer 和 SegmentRow 之间的播放-段落联动
 */
import { create } from 'zustand'

interface PlayerState {
  isPlaying: boolean
  currentTime: number
  duration: number
  playbackRate: number
  activeSegmentId: string | null
  seekTo: number | null

  setIsPlaying: (playing: boolean) => void
  setCurrentTime: (time: number) => void
  setDuration: (duration: number) => void
  setPlaybackRate: (rate: number) => void
  setActiveSegment: (id: string | null) => void
  seekToTime: (time: number) => void
  clearSeek: () => void
  reset: () => void
}

export const usePlayerStore = create<PlayerState>((set) => ({
  isPlaying: false,
  currentTime: 0,
  duration: 0,
  playbackRate: 1,
  activeSegmentId: null,
  seekTo: null,

  setIsPlaying: (playing) => set({ isPlaying: playing }),
  setCurrentTime: (time) => set({ currentTime: time }),
  setDuration: (duration) => set({ duration }),
  setPlaybackRate: (rate) => set({ playbackRate: rate }),
  setActiveSegment: (id) => set({ activeSegmentId: id }),
  seekToTime: (time) => set({ seekTo: time }),
  clearSeek: () => set({ seekTo: null }),
  reset: () =>
    set({
      isPlaying: false,
      currentTime: 0,
      duration: 0,
      playbackRate: 1,
      activeSegmentId: null,
      seekTo: null,
    }),
}))

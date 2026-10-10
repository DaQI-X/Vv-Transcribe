/**
 * 前端路由配置
 * 使用 HashRouter 适配 Electron 环境，当前仅有转写页一个路由
 */
import { createHashRouter } from 'react-router-dom';
import { Transcription } from '@/pages/Transcription';

const routes = [
  {
    path: '/',
    element: <Transcription />,
  },
];

export const router = createHashRouter(routes);

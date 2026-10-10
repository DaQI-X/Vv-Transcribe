/**
 * 渲染进程入口
 * 挂载 React 根组件，初始化 HashRouter 路由
 */
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';
import './index.css';
import { router } from './router/index.tsx';

createRoot(document.getElementById('root')!).render(
  <RouterProvider router={router} />
);

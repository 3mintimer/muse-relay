import './even-theme.css';
import './style.css';
import { createController } from './core/controller';
import { mountApp } from './ui/app';

const root = document.querySelector<HTMLDivElement>('#app');
if (!root) throw new Error('Missing app root');
mountApp(root, createController());

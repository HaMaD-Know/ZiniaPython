import './styles/tokens.css';
import './styles/base.css';
import './styles/layout.css';
import './styles/components.css';
import './styles/console.css';
import './styles/graphics.css';
import { ZiniaApp } from './app/App';

const root = document.getElementById('app');
if (root) {
  const app = new ZiniaApp();
  app.start(root).catch((error: unknown) => {
    console.error(error);
    root.textContent = `ZiniaPython could not start: ${(error as Error)?.message ?? String(error)}`;
  });
}

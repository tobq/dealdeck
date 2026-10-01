import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

// No StrictMode: its double-invoked effects would double-POST imports and double-play narration.
createRoot(document.getElementById('root')!).render(<App />);

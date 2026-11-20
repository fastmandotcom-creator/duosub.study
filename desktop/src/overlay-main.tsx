import { createRoot } from 'react-dom/client';
import { OverlayApp } from './overlay/OverlayApp';
import './styles.css';

const root = document.getElementById('root');
if (root !== null) createRoot(root).render(<OverlayApp />);

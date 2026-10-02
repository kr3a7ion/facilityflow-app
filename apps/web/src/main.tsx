import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SessionProvider } from './lib/session';
import { ApiError } from './lib/api';
import { App } from './App';
import { applyTextSize, textSize } from './lib/textsize';

// Fonts are bundled and served by the host. Linking Google Fonts would look fine on a
// developer laptop and silently fall back to system faces on the office LAN, which has
// no route to the internet at all.
import '@fontsource/archivo/400.css';
import '@fontsource/archivo/500.css';
import '@fontsource/archivo/600.css';
import '@fontsource/archivo/700.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@fontsource/saira-condensed/600.css';
import '@fontsource/saira-condensed/700.css';
import './styles/theme.css';

// The viewer's own theme choice wins over the OS setting. Wrapped because a browser
// set to block site data throws on access rather than returning null.
try {
  const saved = localStorage.getItem('ff-theme');
  if (saved === 'dark' || saved === 'light') document.documentElement.setAttribute('data-theme', saved);
} catch { /* private mode */ }

// Before the first paint, for the same reason as the theme: somebody who needs larger
// type should not have to watch the small version draw itself first.
applyTextSize(textSize());

const client = new QueryClient({
  defaultOptions: {
    queries: {
      // On a weak wifi signal, refetching when the tab comes back is most of what
      // makes the phone feel current.
      refetchOnWindowFocus: true,
      staleTime: 20_000,
      retry: (count, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 2,
    },
    mutations: { retry: false },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      <BrowserRouter>
        <SessionProvider>
          <App />
        </SessionProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>
);

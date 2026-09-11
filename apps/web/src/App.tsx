import { Sheet } from './design/Sheet.tsx';
import { useRoute } from './router.ts';
import { useTheme } from './theme.ts';

export function App() {
  const route = useRoute();
  useTheme();
  if (route.path === '/design') return <Sheet />;
  return <Sheet />;
}

import DataBrowser from './data/DataBrowser';
import { WorkspaceProvider } from './Workspace';

export default function App() {
  return (
    <WorkspaceProvider>
      <DataBrowser />
    </WorkspaceProvider>
  );
}

import { Navigate, Route, Routes, useParams } from 'react-router-dom'
import { AppShell } from '@/components/hud/AppShell'
import { World } from '@/screens/World'
import { Base } from '@/screens/Base'
import { Roster } from '@/screens/Roster'
import { Spawn } from '@/screens/Spawn'
import { Inbox } from '@/screens/Inbox'
import { NewProject } from '@/screens/NewProject'
import { Settings } from '@/screens/Settings'
import { Review } from '@/screens/Review'
import { Quest } from '@/screens/Quest'
import { Ambient } from '@/screens/Ambient'
import { EmptyWorld, DockerDown } from '@/components/states/EmptyStates'

// Remount the base screen per project so its local form state resets.
function BaseRoute() { const { key } = useParams(); return <Base key={key} /> }

export default function App() {
  return (
    <Routes>
      <Route path="/ambient" element={<Ambient />} />
      <Route element={<AppShell />}>
        <Route index element={<World />} />
        <Route path="base/:key" element={<BaseRoute />} />
        <Route path="roster" element={<Roster />} />
        <Route path="spawn" element={<Spawn />} />
        <Route path="inbox" element={<Inbox />} />
        <Route path="new" element={<NewProject />} />
        <Route path="settings" element={<Navigate to="/settings/limits" replace />} />
        <Route path="settings/:section" element={<Settings />} />
        <Route path="review/:pr" element={<Review />} />
        <Route path="quest/:id" element={<Quest />} />
        <Route path="states" element={<div className="grid grid-cols-2"><EmptyWorld /><DockerDown /></div>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}

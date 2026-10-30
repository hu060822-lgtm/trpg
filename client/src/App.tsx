import { useMemo, useState } from 'react';
import { Api } from './api';
import { currentSignIn, forgetSignIn, type SignedIn } from './auth';
import { useRoute } from './hooks';
import { Lobby } from './screens/Lobby';
import { RoomScreen } from './screens/Room';
import { SignIn } from './screens/SignIn';

export function App() {
  const [user, setUser] = useState<SignedIn | null>(currentSignIn);
  const [route, go] = useRoute();
  // A session the server no longer accepts (signed out elsewhere) sends the player back to the sign-in screen.
  const api = useMemo(() => (user ? new Api(user.token, () => { forgetSignIn(); setUser(null); }) : null), [user]);

  if (!user || !api) return <SignIn onSignedIn={setUser} />;

  const [screen, id] = route;
  const signOut = async () => { await user.signOut(); setUser(null); go(''); };
  return (
    <>
      <header className="topbar">
        <a className="brand" href="#/">命運編織<small>FATEWEAVE</small></a>
        <span className="spacer" />
        <span className="muted small">{user.label}</span>
        <button className="link" onClick={signOut}>登出</button>
      </header>
      {screen === 'room' && id ? <RoomScreen key={id} api={api} roomId={id} go={go} /> : <Lobby api={api} go={go} />}
    </>
  );
}

import { useMemo, useState } from 'react';
import { Api } from './api';
import { currentSignIn, forgetSignIn, type SignedIn } from './auth';
import { useRoute } from './hooks';
import { CreateCharacter } from './screens/CreateCharacter';
import { GmDesk } from './screens/GmDesk';
import { Lobby } from './screens/Lobby';
import { Play } from './screens/Play';
import { SignIn } from './screens/SignIn';

export function App() {
  const [user, setUser] = useState<SignedIn | null>(currentSignIn);
  const [route, go] = useRoute();
  // A session the server no longer accepts (signed out elsewhere) sends the player back to the sign-in screen.
  const api = useMemo(() => (user ? new Api(user.token, () => { forgetSignIn(); setUser(null); }) : null), [user]);

  if (!user || !api) return <SignIn onSignedIn={setUser} />;

  const [screen, a, b] = route;
  const signOut = async () => { await user.signOut(); setUser(null); go(''); };
  return (
    <>
      <header className="topbar">
        <a className="brand" href="#/">命運編織<small>FATEWEAVE</small></a>
        <span className="spacer" />
        <span className="muted small">{user.label}</span>
        <button className="link" onClick={signOut}>登出</button>
      </header>
      {screen === 'create' ? <CreateCharacter api={api} go={go} />
        : screen === 'play' && a && b ? <Play api={api} worldId={a} characterId={b} go={go} />
          : screen === 'gm' && a ? <GmDesk api={api} worldId={a} />
            : <Lobby api={api} go={go} />}
    </>
  );
}

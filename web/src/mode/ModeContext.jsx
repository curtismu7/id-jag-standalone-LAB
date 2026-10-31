import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import api from "../services/api";

// The app's Mock/Live setting, as the server holds it (GET /api/mode). The server saves the choice, so it survives a reload.
// A switch ends every web session on the server (a session holds the tokens of one mode only), so the page reloads after it.

const Ctx = createContext(null);
/** null outside a provider; { mode, live, mockUser, signin, status, ... } inside. */
export const useAppMode = () => useContext(Ctx);

const known = (d) => d && (d.mode === "mock" || d.mode === "live") && d.live && typeof d.live === "object";
const reloadPage = () => window.location.reload();

export function ModeProvider({ children, reload = reloadPage }) {
  const [info, setInfo] = useState(null);
  const [status, setStatus] = useState("loading"); // loading | ready | unavailable
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    api.get("/api/mode")
      .then((r) => { if (!alive) return; if (known(r.data)) { setInfo(r.data); setStatus("ready"); } else setStatus("unavailable"); })
      .catch(() => alive && setStatus("unavailable"));
    return () => { alive = false; };
  }, []);

  const choose = useCallback(async (next) => {
    if (switching || !info || next === info.mode) return;
    setSwitching(true);
    setError("");
    try {
      const r = await api.post("/api/mode", { mode: next });
      if (known(r.data)) setInfo(r.data);
      reload();
    } catch (e) {
      setError(e.response?.data?.message || "The mode could not be changed. Try again.");
    } finally {
      setSwitching(false);
    }
  }, [switching, info, reload]);

  const value = useMemo(() => ({ ...(info || {}), status, switching, error, choose }), [info, status, switching, error, choose]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

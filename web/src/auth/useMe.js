import { useEffect, useState } from "react";
import api from "../services/api";

/** The signed-in user ({ email, name, isAdmin }), null when signed out, undefined while loading. */
export function useMe() {
  const [me, setMe] = useState(undefined);
  useEffect(() => {
    let live = true;
    api.get("/api/me", { validateStatus: (s) => s === 200 || s === 401 })
      .then((r) => live && setMe(r.status === 200 && r.data?.email ? r.data : null))
      .catch(() => live && setMe(null));
    return () => { live = false; };
  }, []);
  return me;
}

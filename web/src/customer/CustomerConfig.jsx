import { createContext, useContext, useEffect, useState } from "react";
import api from "../services/api";
import { brandVars } from "./brand";

// The optional customer.config.json, as the server sanitised it. Fetched once; any failure means the kit defaults.
const NONE = {};
const Ctx = createContext(NONE);
export const useCustomer = () => useContext(Ctx);

export function CustomerProvider({ children }) {
  const [config, setConfig] = useState(NONE);
  useEffect(() => {
    let live = true;
    api.get("/api/customer-config")
      .then((r) => live && r.data && typeof r.data === "object" && setConfig(r.data))
      .catch(() => { /* no config: defaults */ });
    return () => { live = false; };
  }, []);
  useEffect(() => {
    const style = document.documentElement.style;
    const vars = brandVars(config.brand);
    Object.entries(vars).forEach(([k, v]) => style.setProperty(k, v));
    return () => Object.keys(vars).forEach((k) => style.removeProperty(k));
  }, [config]);
  return <Ctx.Provider value={config}>{children}</Ctx.Provider>;
}

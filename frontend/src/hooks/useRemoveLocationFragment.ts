import { useCallback } from "react";
import { useLocation, useNavigate } from "react-router-dom";

export function useRemoveLocationFragment() {
  const location = useLocation();
  const navigate = useNavigate();
  return useCallback(
    (keys: readonly string[]) => {
      const fragment = new URLSearchParams(location.hash.replace(/^#/, ""));
      for (const key of keys) fragment.delete(key);
      const hash = fragment.toString();
      void navigate(
        { pathname: location.pathname, search: location.search, hash: hash ? `#${hash}` : "" },
        { replace: true, state: location.state }
      );
    },
    [location, navigate]
  );
}

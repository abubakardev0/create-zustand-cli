import { create } from "zustand";
import { persist } from "zustand/middleware";

const use__STORE_NAME__ = create(
  persist(
    (set) => ({
      __INITIAL_STATE__,
      actions: {
        __ACTIONS__,
      },
    }),
    {
      name: "__STORE_NAME__",
    }
  )
);

export default use__STORE_NAME__;

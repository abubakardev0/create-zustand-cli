import { create } from "zustand";

interface State {
  __INITIAL_STATE_TYPES__;
  actions: {
    __ACTIONS_TYPES__;
  };
}

const use__STORE_NAME__ = create<State>((set) => ({
  __INITIAL_STATE__,
  actions: {
    __ACTIONS__,
  },
}));

export default use__STORE_NAME__;

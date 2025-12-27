import { nanoid } from "nanoid";
import { createPersistStore } from "../utils/store";
import { StoreKey } from "../constant";

export interface Profile {
  id: string;
  name: string;
}

export interface ProfileStore {
  profiles: Profile[];
  currentProfileId: string | null;

  createProfile: (name: string) => void;
  deleteProfile: (id: string) => void;
  selectProfile: (id: string | null) => void;
}

const DEFAULT_PROFILE_STATE = {
  profiles: [] as Profile[],
  currentProfileId: null as string | null,
};

export const useProfileStore = createPersistStore(
  DEFAULT_PROFILE_STATE,
  (set, get) => ({
    createProfile(name: string) {
      const profile = {
        id: nanoid(),
        name,
      };
      set((state) => ({
        profiles: [...state.profiles, profile],
        currentProfileId: profile.id, // Auto-select new profile
      }));
    },

    deleteProfile(id: string) {
      set((state) => {
        const nextProfiles = state.profiles.filter((p) => p.id !== id);
        let nextProfileId = state.currentProfileId;
        if (state.currentProfileId === id) {
          nextProfileId = null; // Switch to default if current is deleted
        }
        return {
          profiles: nextProfiles,
          currentProfileId: nextProfileId,
        };
      });
    },

    selectProfile(id: string | null) {
      set(() => ({
        currentProfileId: id,
      }));
    },
  }),
  {
    name: StoreKey.Profile,
    version: 1,
  },
);

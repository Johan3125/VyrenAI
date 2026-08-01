export const VISUAL_STYLE_LIST_CHANNEL = "visual-styles:list";
export const VISUAL_STYLE_SAVE_CHANNEL = "visual-styles:save";
export const VISUAL_STYLE_DELETE_CHANNEL = "visual-styles:delete";

export interface GraphicStylePreset {
  id: string;
  name: string;
  style: string;
  builtIn: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface GraphicStyleSaveInput {
  name: string;
  style: string;
}

export interface VisualStylesBridge {
  list: () => Promise<GraphicStylePreset[]>;
  save: (input: GraphicStyleSaveInput) => Promise<GraphicStylePreset[]>;
  remove: (id: string) => Promise<GraphicStylePreset[]>;
}


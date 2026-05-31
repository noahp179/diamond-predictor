export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      daily_metrics: {
        Row: {
          accuracy: number | null
          brier: number | null
          correct: number
          games: number
          log_loss: number | null
          metric_date: string
          model_version: string
          settled: number
          updated_at: string
        }
        Insert: {
          accuracy?: number | null
          brier?: number | null
          correct: number
          games: number
          log_loss?: number | null
          metric_date: string
          model_version: string
          settled: number
          updated_at?: string
        }
        Update: {
          accuracy?: number | null
          brier?: number | null
          correct?: number
          games?: number
          log_loss?: number | null
          metric_date?: string
          model_version?: string
          settled?: number
          updated_at?: string
        }
        Relationships: []
      }
      games: {
        Row: {
          away_score: number | null
          away_team_abbr: string
          away_team_id: number
          away_team_name: string
          created_at: string
          game_date: string
          game_id: number
          game_time: string
          home_score: number | null
          home_team_abbr: string
          home_team_id: number
          home_team_name: string
          raw: Json | null
          status: string
          updated_at: string
          venue: string | null
          winner: string | null
        }
        Insert: {
          away_score?: number | null
          away_team_abbr: string
          away_team_id: number
          away_team_name: string
          created_at?: string
          game_date: string
          game_id: number
          game_time: string
          home_score?: number | null
          home_team_abbr: string
          home_team_id: number
          home_team_name: string
          raw?: Json | null
          status: string
          updated_at?: string
          venue?: string | null
          winner?: string | null
        }
        Update: {
          away_score?: number | null
          away_team_abbr?: string
          away_team_id?: number
          away_team_name?: string
          created_at?: string
          game_date?: string
          game_id?: number
          game_time?: string
          home_score?: number | null
          home_team_abbr?: string
          home_team_id?: number
          home_team_name?: string
          raw?: Json | null
          status?: string
          updated_at?: string
          venue?: string | null
          winner?: string | null
        }
        Relationships: []
      }
      predictions: {
        Row: {
          away_pitcher_era: number | null
          away_pitcher_id: number | null
          away_pitcher_name: string | null
          away_win_pct: number | null
          away_win_prob: number
          brier: number | null
          correct: boolean | null
          game_id: number
          home_pitcher_era: number | null
          home_pitcher_id: number | null
          home_pitcher_name: string | null
          home_win_pct: number | null
          home_win_prob: number
          log_loss: number | null
          model_version: string
          predicted_at: string
          rationale: Json | null
          settled_at: string | null
        }
        Insert: {
          away_pitcher_era?: number | null
          away_pitcher_id?: number | null
          away_pitcher_name?: string | null
          away_win_pct?: number | null
          away_win_prob: number
          brier?: number | null
          correct?: boolean | null
          game_id: number
          home_pitcher_era?: number | null
          home_pitcher_id?: number | null
          home_pitcher_name?: string | null
          home_win_pct?: number | null
          home_win_prob: number
          log_loss?: number | null
          model_version: string
          predicted_at?: string
          rationale?: Json | null
          settled_at?: string | null
        }
        Update: {
          away_pitcher_era?: number | null
          away_pitcher_id?: number | null
          away_pitcher_name?: string | null
          away_win_pct?: number | null
          away_win_prob?: number
          brier?: number | null
          correct?: boolean | null
          game_id?: number
          home_pitcher_era?: number | null
          home_pitcher_id?: number | null
          home_pitcher_name?: string | null
          home_win_pct?: number | null
          home_win_prob?: number
          log_loss?: number | null
          model_version?: string
          predicted_at?: string
          rationale?: Json | null
          settled_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "predictions_game_id_fkey"
            columns: ["game_id"]
            isOneToOne: false
            referencedRelation: "games"
            referencedColumns: ["game_id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const

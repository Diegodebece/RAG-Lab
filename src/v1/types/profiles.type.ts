// what the API returns about a profile; never the owner's id or the configuration version
export interface Profile {
    id: string;
    name: string;
    // only what the user set; the rest comes from the default profile when the configuration is resolved
    settings: Record<string, unknown>;
    // what is wrong with the stored settings today (a value outside a cap, a setting this version does not have); empty
    // for a profile made through the API, which checks them first
    problems: string[];
    createdAt: Date;
    updatedAt: Date;
}

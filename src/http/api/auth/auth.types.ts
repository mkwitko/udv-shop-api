export type PublicUser = {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
};

export type AuthResult = {
  accessToken: string;
  refreshToken: string;
  user: PublicUser;
};

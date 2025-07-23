export interface User {
  id: string;
  name: string;
  email?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface SignInRequest {
  name: string;
}

export interface SignInResponse {
  user: User;
  isNewUser: boolean;
}

export interface UpdateUserRequest {
  id: string;
  name?: string;
  email?: string;
}
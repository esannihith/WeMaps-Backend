export interface User {
  id: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface SignInRequest {
  name: string;
  password: string;
}

export interface SignUpRequest {
  name: string;
  password: string;
}

export interface SignInResponse {
  user: User;
  token: string;
  isNewUser: boolean;
}

export interface SignUpResponse {
  user: User;
  token: string;
}

export interface UpdateUserRequest {
  id: string;
  name?: string;
}
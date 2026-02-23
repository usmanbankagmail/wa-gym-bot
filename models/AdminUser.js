import mongoose from "mongoose";

const AdminUserSchema = new mongoose.Schema(
  {
    name: { type: String, default: "Admin" },
    email: { type: String, required: true, unique: true, index: true },
    passwordHash: { type: String, required: true },
    role: { type: String, enum: ["admin", "manager"], default: "admin" },
    active: { type: Boolean, default: true }
  },
  { timestamps: true }
);

export default mongoose.model("AdminUser", AdminUserSchema);
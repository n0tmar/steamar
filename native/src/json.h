// A small JSON reader/writer. Steam's responses and our own cache files are the only input,
// so this covers objects, arrays, strings, numbers, bools and null - and nothing newer.
#pragma once

#include <cmath>
#include <cstdio>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace json {

enum class Type { Null, Bool, Number, String, Array, Object };

class Value {
 public:
  Value() = default;

  static Value null() { return Value(); }
  static Value boolean(bool b) {
    Value v;
    v.type_ = Type::Bool;
    v.bool_ = b;
    return v;
  }
  static Value number(double n) {
    Value v;
    v.type_ = Type::Number;
    v.number_ = n;
    return v;
  }
  static Value str(std::string s) {
    Value v;
    v.type_ = Type::String;
    v.string_ = std::move(s);
    return v;
  }
  static Value array() {
    Value v;
    v.type_ = Type::Array;
    return v;
  }
  static Value object() {
    Value v;
    v.type_ = Type::Object;
    return v;
  }

  Type type() const { return type_; }
  bool is_null() const { return type_ == Type::Null; }
  bool is_object() const { return type_ == Type::Object; }
  bool is_array() const { return type_ == Type::Array; }
  bool is_string() const { return type_ == Type::String; }
  bool is_number() const { return type_ == Type::Number; }

  bool as_bool(bool fallback = false) const { return type_ == Type::Bool ? bool_ : fallback; }
  double as_number(double fallback = 0) const { return type_ == Type::Number ? number_ : fallback; }
  long long as_int(long long fallback = 0) const {
    return type_ == Type::Number ? static_cast<long long>(number_) : fallback;
  }
  const std::string& as_string() const { return string_; }

  size_t size() const {
    if (type_ == Type::Array) return items_.size();
    if (type_ == Type::Object) return members_.size();
    return 0;
  }

  const Value& at(size_t index) const {
    static const Value empty;
    return type_ == Type::Array && index < items_.size() ? items_[index] : empty;
  }

  const Value& operator[](std::string_view key) const {
    static const Value empty;
    if (type_ != Type::Object) return empty;
    for (const auto& [k, v] : members_) {
      if (k == key) return v;
    }
    return empty;
  }

  const std::vector<std::pair<std::string, Value>>& members() const { return members_; }

  void push(Value value) {
    if (type_ != Type::Array) {
      type_ = Type::Array;
      items_.clear();
    }
    items_.push_back(std::move(value));
  }

  void set(std::string key, Value value) {
    if (type_ != Type::Object) {
      type_ = Type::Object;
      members_.clear();
    }
    for (auto& [k, v] : members_) {
      if (k == key) {
        v = std::move(value);
        return;
      }
    }
    members_.emplace_back(std::move(key), std::move(value));
  }

  static bool parse(std::string_view text, Value& out);

 private:
  Type type_ = Type::Null;
  bool bool_ = false;
  double number_ = 0;
  std::string string_;
  std::vector<Value> items_;
  std::vector<std::pair<std::string, Value>> members_;
};

inline void escape_to(std::string_view text, std::string& out) {
  out += '"';
  for (unsigned char c : text) {
    switch (c) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      case '\b': out += "\\b"; break;
      case '\f': out += "\\f"; break;
      default:
        if (c < 0x20) {
          char buf[8];
          std::snprintf(buf, sizeof buf, "\\u%04x", c);
          out += buf;
        } else {
          out += static_cast<char>(c);
        }
    }
  }
  out += '"';
}

void write(const Value& value, std::string& out);

inline std::string dump(const Value& value) {
  std::string out;
  out.reserve(256);
  write(value, out);
  return out;
}

namespace detail {

struct Parser {
  std::string_view text;
  size_t pos = 0;

  void skip() {
    while (pos < text.size()) {
      const char c = text[pos];
      if (c == ' ' || c == '\t' || c == '\n' || c == '\r') ++pos;
      else break;
    }
  }

  bool literal(std::string_view word) {
    if (text.compare(pos, word.size(), word) != 0) return false;
    pos += word.size();
    return true;
  }

  bool string(std::string& out) {
    if (pos >= text.size() || text[pos] != '"') return false;
    ++pos;
    out.clear();
    while (pos < text.size()) {
      const char c = text[pos++];
      if (c == '"') return true;
      if (c != '\\') {
        out += c;
        continue;
      }
      if (pos >= text.size()) return false;
      const char esc = text[pos++];
      switch (esc) {
        case '"': out += '"'; break;
        case '\\': out += '\\'; break;
        case '/': out += '/'; break;
        case 'b': out += '\b'; break;
        case 'f': out += '\f'; break;
        case 'n': out += '\n'; break;
        case 'r': out += '\r'; break;
        case 't': out += '\t'; break;
        case 'u': {
          if (pos + 4 > text.size()) return false;
          unsigned code = 0;
          for (int i = 0; i < 4; ++i) {
            const char h = text[pos++];
            code <<= 4;
            if (h >= '0' && h <= '9') code |= static_cast<unsigned>(h - '0');
            else if (h >= 'a' && h <= 'f') code |= static_cast<unsigned>(h - 'a' + 10);
            else if (h >= 'A' && h <= 'F') code |= static_cast<unsigned>(h - 'A' + 10);
            else return false;
          }
          if (code < 0x80) {
            out += static_cast<char>(code);
          } else if (code < 0x800) {
            out += static_cast<char>(0xC0 | (code >> 6));
            out += static_cast<char>(0x80 | (code & 0x3F));
          } else {
            out += static_cast<char>(0xE0 | (code >> 12));
            out += static_cast<char>(0x80 | ((code >> 6) & 0x3F));
            out += static_cast<char>(0x80 | (code & 0x3F));
          }
          break;
        }
        default: return false;
      }
    }
    return false;
  }

  bool value(Value& out, int depth) {
    if (depth > 64) return false;
    skip();
    if (pos >= text.size()) return false;
    const char c = text[pos];
    if (c == '{') {
      ++pos;
      out = Value::object();
      skip();
      if (pos < text.size() && text[pos] == '}') {
        ++pos;
        return true;
      }
      for (;;) {
        skip();
        std::string key;
        if (!string(key)) return false;
        skip();
        if (pos >= text.size() || text[pos] != ':') return false;
        ++pos;
        Value child;
        if (!value(child, depth + 1)) return false;
        out.set(std::move(key), std::move(child));
        skip();
        if (pos < text.size() && text[pos] == ',') {
          ++pos;
          continue;
        }
        if (pos < text.size() && text[pos] == '}') {
          ++pos;
          return true;
        }
        return false;
      }
    }
    if (c == '[') {
      ++pos;
      out = Value::array();
      skip();
      if (pos < text.size() && text[pos] == ']') {
        ++pos;
        return true;
      }
      for (;;) {
        Value child;
        if (!value(child, depth + 1)) return false;
        out.push(std::move(child));
        skip();
        if (pos < text.size() && text[pos] == ',') {
          ++pos;
          continue;
        }
        if (pos < text.size() && text[pos] == ']') {
          ++pos;
          return true;
        }
        return false;
      }
    }
    if (c == '"') {
      std::string s;
      if (!string(s)) return false;
      out = Value::str(std::move(s));
      return true;
    }
    if (literal("true")) {
      out = Value::boolean(true);
      return true;
    }
    if (literal("false")) {
      out = Value::boolean(false);
      return true;
    }
    if (literal("null")) {
      out = Value::null();
      return true;
    }
    // number
    const size_t start = pos;
    if (pos < text.size() && (text[pos] == '-' || text[pos] == '+')) ++pos;
    bool digits = false;
    while (pos < text.size() && ((text[pos] >= '0' && text[pos] <= '9') || text[pos] == '.' || text[pos] == 'e' ||
                                 text[pos] == 'E' || text[pos] == '-' || text[pos] == '+')) {
      if (text[pos] >= '0' && text[pos] <= '9') digits = true;
      ++pos;
    }
    if (!digits) {
      pos = start;
      return false;
    }
    out = Value::number(std::strtod(std::string(text.substr(start, pos - start)).c_str(), nullptr));
    return true;
  }
};

}  // namespace detail

inline bool Value::parse(std::string_view text, Value& out) {
  detail::Parser p{text};
  if (!p.value(out, 0)) return false;
  p.skip();
  return true;
}

inline void write_number(double n, std::string& out) {
  if (std::isfinite(n) && n == static_cast<long long>(n) && std::fabs(n) < 1e15) {
    out += std::to_string(static_cast<long long>(n));
    return;
  }
  char buf[40];
  std::snprintf(buf, sizeof buf, "%.10g", n);
  out += buf;
}

inline void write(const Value& value, std::string& out) {
  switch (value.type()) {
    case Type::Null: out += "null"; break;
    case Type::Bool: out += value.as_bool() ? "true" : "false"; break;
    case Type::Number: write_number(value.as_number(), out); break;
    case Type::String: escape_to(value.as_string(), out); break;
    case Type::Array: {
      out += '[';
      for (size_t i = 0; i < value.size(); ++i) {
        if (i) out += ',';
        write(value.at(i), out);
      }
      out += ']';
      break;
    }
    case Type::Object: {
      out += '{';
      bool first = true;
      for (const auto& [key, child] : value.members()) {
        if (!first) out += ',';
        first = false;
        escape_to(key, out);
        out += ':';
        write(child, out);
      }
      out += '}';
      break;
    }
  }
}

}  // namespace json

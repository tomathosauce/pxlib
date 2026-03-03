#include <node_api.h>

#include <cstdint>
#include <cstdio>
#include <string>

extern "C" {
#include "paradox.h"
#include "pxversion.h"
}

namespace {

const char* FieldTypeName(int type) {
  switch (type) {
    case pxfAlpha: return "alpha";
    case pxfDate: return "date";
    case pxfShort: return "short";
    case pxfLong: return "long";
    case pxfCurrency: return "currency";
    case pxfNumber: return "number";
    case pxfLogical: return "logical";
    case pxfMemoBLOb: return "memoBlob";
    case pxfBLOb: return "blob";
    case pxfFmtMemoBLOb: return "formattedMemoBlob";
    case pxfOLE: return "ole";
    case pxfGraphic: return "graphic";
    case pxfTime: return "time";
    case pxfTimestamp: return "timestamp";
    case pxfAutoInc: return "autoInc";
    case pxfBCD: return "bcd";
    case pxfBytes: return "bytes";
    default: return "unknown";
  }
}

void ThrowLastError(napi_env env, const std::string& message) {
  napi_throw_error(env, nullptr, message.c_str());
}

bool CheckStatus(napi_env env, napi_status status) {
  if (status == napi_ok) {
    return true;
  }

  const napi_extended_error_info* info = nullptr;
  napi_get_last_error_info(env, &info);
  napi_throw_error(env, nullptr, info && info->error_message ? info->error_message : "N-API error");
  return false;
}

bool GetUtf8(napi_env env, napi_value value, std::string* out) {
  size_t length = 0;
  if (!CheckStatus(env, napi_get_value_string_utf8(env, value, nullptr, 0, &length))) {
    return false;
  }

  std::string buffer(length + 1, '\0');
  if (!CheckStatus(env, napi_get_value_string_utf8(env, value, buffer.data(), buffer.size(), &length))) {
    return false;
  }
  buffer.resize(length);
  *out = buffer;
  return true;
}

bool GetOptionalNamedString(napi_env env, napi_value options, const char* key, std::string* out, bool* present) {
  *present = false;

  bool has_property = false;
  if (!CheckStatus(env, napi_has_named_property(env, options, key, &has_property))) {
    return false;
  }
  if (!has_property) {
    return true;
  }

  napi_value value;
  if (!CheckStatus(env, napi_get_named_property(env, options, key, &value))) {
    return false;
  }

  napi_valuetype type;
  if (!CheckStatus(env, napi_typeof(env, value, &type))) {
    return false;
  }
  if (type != napi_string) {
    ThrowLastError(env, std::string("Option '") + key + "' must be a string");
    return false;
  }

  if (!GetUtf8(env, value, out)) {
    return false;
  }

  *present = true;
  return true;
}

napi_value MakeString(napi_env env, const std::string& value) {
  napi_value result;
  napi_create_string_utf8(env, value.c_str(), value.size(), &result);
  return result;
}

napi_value MakeString(napi_env env, const char* value) {
  napi_value result;
  napi_create_string_utf8(env, value, NAPI_AUTO_LENGTH, &result);
  return result;
}

napi_value MakeInt32(napi_env env, int32_t value) {
  napi_value result;
  napi_create_int32(env, value, &result);
  return result;
}

napi_value MakeInt64(napi_env env, int64_t value) {
  napi_value result;
  napi_create_int64(env, value, &result);
  return result;
}

napi_value MakeDouble(napi_env env, double value) {
  napi_value result;
  napi_create_double(env, value, &result);
  return result;
}

napi_value MakeBoolean(napi_env env, bool value) {
  napi_value result;
  napi_get_boolean(env, value, &result);
  return result;
}

napi_value MakeNull(napi_env env) {
  napi_value result;
  napi_get_null(env, &result);
  return result;
}

void FreeRetrievedRecord(pxdoc_t* doc, pxval_t** values, int count) {
  if (doc == nullptr || values == nullptr) {
    return;
  }

  for (int i = 0; i < count; ++i) {
    if (values[i] == nullptr) {
      continue;
    }

    if (!values[i]->isnull) {
      switch (values[i]->type) {
        case pxfAlpha:
        case pxfMemoBLOb:
        case pxfBLOb:
        case pxfFmtMemoBLOb:
        case pxfOLE:
        case pxfGraphic:
        case pxfBytes:
        case pxfBCD:
          if (values[i]->value.str.val != nullptr) {
            doc->free(doc, values[i]->value.str.val);
          }
          break;
        default:
          break;
      }
    }

    doc->free(doc, values[i]);
  }

  doc->free(doc, values);
}

class Database {
 public:
  Database() = default;

  ~Database() {
    CloseInternal();
  }

  static void ErrorHandler(pxdoc_t* /*doc*/, int level, const char* msg, void* data) {
    if (data == nullptr || level == PX_Warning) {
      return;
    }

    Database* self = static_cast<Database*>(data);
    self->last_error_ = msg != nullptr ? msg : "pxlib error";
  }

  bool Open(const std::string& path, const std::string* blob_file,
            const std::string* input_encoding, const std::string* target_encoding) {
    doc_ = PX_new3(ErrorHandler, nullptr, nullptr, nullptr, this);
    if (doc_ == nullptr) {
      if (last_error_.empty()) {
        last_error_ = "Failed to allocate pxlib document";
      }
      return false;
    }

    FILE* fp = std::fopen(path.c_str(), "rb");
    if (fp == nullptr) {
      last_error_ = "Could not open Paradox database file";
      return false;
    }

    if (PX_open_fp(doc_, fp) < 0) {
      if (doc_->px_stream != nullptr) {
        doc_->px_stream->close = px_true;
      }
      if (last_error_.empty()) {
        last_error_ = "Could not open Paradox database";
      }
      return false;
    }

    doc_->px_stream->close = px_true;
    doc_->px_name = PX_strdup(doc_, path.c_str());

    if (blob_file != nullptr && PX_set_blob_file(doc_, blob_file->c_str()) < 0) {
      if (last_error_.empty()) {
        last_error_ = "Could not attach blob file";
      }
      return false;
    }

    if (input_encoding != nullptr && PX_set_inputencoding(doc_, input_encoding->c_str()) < 0) {
      if (last_error_.empty()) {
        last_error_ = "Could not set input encoding";
      }
      return false;
    }

    if (target_encoding != nullptr && PX_set_targetencoding(doc_, target_encoding->c_str()) < 0) {
      if (last_error_.empty()) {
        last_error_ = "Could not set target encoding";
      }
      return false;
    }

    return true;
  }

  void CloseInternal() {
    if (doc_ != nullptr) {
      PX_delete(doc_);
      doc_ = nullptr;
    }
  }

  bool EnsureOpen(napi_env env) const {
    if (doc_ != nullptr) {
      return true;
    }
    ThrowLastError(env, "Database is closed");
    return false;
  }

  std::string TakeError(const std::string& fallback) {
    if (last_error_.empty()) {
      return fallback;
    }
    std::string message = last_error_;
    last_error_.clear();
    return message;
  }

  static Database* Unwrap(napi_env env, napi_callback_info info, napi_value* this_arg, size_t argc, napi_value* argv) {
    if (!CheckStatus(env, napi_get_cb_info(env, info, &argc, argv, this_arg, nullptr))) {
      return nullptr;
    }

    Database* self = nullptr;
    if (!CheckStatus(env, napi_unwrap(env, *this_arg, reinterpret_cast<void**>(&self)))) {
      return nullptr;
    }
    return self;
  }

  static void Finalize(napi_env /*env*/, void* data, void* /*hint*/) {
    delete static_cast<Database*>(data);
  }

  static napi_value Constructor(napi_env env, napi_callback_info info) {
    napi_value argv[2];
    napi_value this_arg;
    Database* self = new Database();

    size_t argc = 2;
    if (!CheckStatus(env, napi_get_cb_info(env, info, &argc, argv, &this_arg, nullptr))) {
      delete self;
      return nullptr;
    }

    if (argc < 1) {
      delete self;
      ThrowLastError(env, "Database path is required");
      return nullptr;
    }

    napi_valuetype arg_type;
    if (!CheckStatus(env, napi_typeof(env, argv[0], &arg_type))) {
      delete self;
      return nullptr;
    }
    if (arg_type != napi_string) {
      delete self;
      ThrowLastError(env, "Database path must be a string");
      return nullptr;
    }

    std::string path;
    if (!GetUtf8(env, argv[0], &path)) {
      delete self;
      return nullptr;
    }

    std::string blob_file;
    std::string input_encoding;
    std::string target_encoding;
    std::string* blob_ptr = nullptr;
    std::string* input_ptr = nullptr;
    std::string* target_ptr = nullptr;

    if (argc >= 2) {
      napi_valuetype options_type;
      if (!CheckStatus(env, napi_typeof(env, argv[1], &options_type))) {
        delete self;
        return nullptr;
      }
      if (options_type != napi_undefined && options_type != napi_null) {
        if (options_type != napi_object) {
          delete self;
          ThrowLastError(env, "Options must be an object");
          return nullptr;
        }

        bool present = false;
        if (!GetOptionalNamedString(env, argv[1], "blobFile", &blob_file, &present)) {
          delete self;
          return nullptr;
        }
        if (present) {
          blob_ptr = &blob_file;
        }

        if (!GetOptionalNamedString(env, argv[1], "inputEncoding", &input_encoding, &present)) {
          delete self;
          return nullptr;
        }
        if (present) {
          input_ptr = &input_encoding;
        }

        if (!GetOptionalNamedString(env, argv[1], "targetEncoding", &target_encoding, &present)) {
          delete self;
          return nullptr;
        }
        if (present) {
          target_ptr = &target_encoding;
        }
      }
    }

    if (!self->Open(path, blob_ptr, input_ptr, target_ptr)) {
      std::string message = self->TakeError("Failed to open database");
      delete self;
      ThrowLastError(env, message);
      return nullptr;
    }

    if (!CheckStatus(env, napi_wrap(env, this_arg, self, Finalize, nullptr, nullptr))) {
      delete self;
      return nullptr;
    }

    return this_arg;
  }

  static napi_value Close(napi_env env, napi_callback_info info) {
    napi_value this_arg;
    napi_value argv[1];
    Database* self = Unwrap(env, info, &this_arg, 0, argv);
    if (self == nullptr) {
      return nullptr;
    }

    self->CloseInternal();
    napi_value result;
    napi_get_undefined(env, &result);
    return result;
  }

  static napi_value GetFieldCount(napi_env env, napi_callback_info info) {
    napi_value this_arg;
    napi_value argv[1];
    Database* self = Unwrap(env, info, &this_arg, 0, argv);
    if (self == nullptr || !self->EnsureOpen(env)) {
      return nullptr;
    }

    int value = PX_get_num_fields(self->doc_);
    if (value < 0) {
      ThrowLastError(env, self->TakeError("Failed to read field count"));
      return nullptr;
    }
    return MakeInt32(env, value);
  }

  static napi_value GetRecordCount(napi_env env, napi_callback_info info) {
    napi_value this_arg;
    napi_value argv[1];
    Database* self = Unwrap(env, info, &this_arg, 0, argv);
    if (self == nullptr || !self->EnsureOpen(env)) {
      return nullptr;
    }

    int value = PX_get_num_records(self->doc_);
    if (value < 0) {
      ThrowLastError(env, self->TakeError("Failed to read record count"));
      return nullptr;
    }
    return MakeInt32(env, value);
  }

  static napi_value GetInfo(napi_env env, napi_callback_info info) {
    napi_value this_arg;
    napi_value argv[1];
    Database* self = Unwrap(env, info, &this_arg, 0, argv);
    if (self == nullptr || !self->EnsureOpen(env)) {
      return nullptr;
    }

    napi_value result;
    napi_create_object(env, &result);
    napi_set_named_property(env, result, "recordCount", MakeInt32(env, self->doc_->px_head->px_numrecords));
    napi_set_named_property(env, result, "fieldCount", MakeInt32(env, self->doc_->px_head->px_numfields));
    napi_set_named_property(env, result, "recordSize", MakeInt32(env, self->doc_->px_head->px_recordsize));
    napi_set_named_property(env, result, "fileType", MakeInt32(env, self->doc_->px_head->px_filetype));
    napi_set_named_property(env, result, "fileVersion", MakeInt32(env, self->doc_->px_head->px_fileversion));
    napi_set_named_property(env, result, "headerSize", MakeInt32(env, self->doc_->px_head->px_headersize));
    napi_set_named_property(env, result, "codePage", MakeInt32(env, self->doc_->px_head->px_doscodepage));
    napi_set_named_property(env, result, "encrypted", MakeBoolean(env, self->doc_->px_head->px_encryption != 0));
    napi_set_named_property(
      env,
      result,
      "tableName",
      self->doc_->px_head->px_tablename ? MakeString(env, self->doc_->px_head->px_tablename) : MakeNull(env));
    return result;
  }

  static napi_value GetFields(napi_env env, napi_callback_info info) {
    napi_value this_arg;
    napi_value argv[1];
    Database* self = Unwrap(env, info, &this_arg, 0, argv);
    if (self == nullptr || !self->EnsureOpen(env)) {
      return nullptr;
    }

    int count = PX_get_num_fields(self->doc_);
    if (count < 0) {
      ThrowLastError(env, self->TakeError("Failed to read fields"));
      return nullptr;
    }

    pxfield_t* fields = PX_get_fields(self->doc_);
    if (fields == nullptr) {
      ThrowLastError(env, self->TakeError("Failed to read fields"));
      return nullptr;
    }

    napi_value result;
    napi_create_array_with_length(env, count, &result);

    for (int i = 0; i < count; ++i) {
      napi_value item;
      napi_create_object(env, &item);
      napi_set_named_property(env, item, "name", fields[i].px_fname ? MakeString(env, fields[i].px_fname) : MakeNull(env));
      napi_set_named_property(env, item, "type", MakeInt32(env, fields[i].px_ftype));
      napi_set_named_property(env, item, "typeName", MakeString(env, FieldTypeName(fields[i].px_ftype)));
      napi_set_named_property(env, item, "length", MakeInt32(env, fields[i].px_flen));
      napi_set_named_property(env, item, "decimalCount", MakeInt32(env, fields[i].px_fdc));
      napi_set_element(env, result, i, item);
    }

    return result;
  }

  napi_value ConvertValue(napi_env env, pxfield_t* field, pxval_t* value) {
    if (value->isnull) {
      return MakeNull(env);
    }

    switch (field->px_ftype) {
      case pxfShort:
      case pxfDate:
      case pxfTime:
      case pxfAutoInc:
      case pxfLong:
        return MakeInt64(env, static_cast<int64_t>(value->value.lval));
      case pxfLogical:
        return MakeBoolean(env, value->value.lval != 0);
      case pxfTimestamp:
      case pxfCurrency:
      case pxfNumber:
        return MakeDouble(env, value->value.dval);
      case pxfAlpha:
      case pxfBCD:
        return MakeString(env, value->value.str.val ? value->value.str.val : "");
      case pxfBytes:
      case pxfGraphic:
      case pxfBLOb:
      case pxfFmtMemoBLOb:
      case pxfMemoBLOb:
      case pxfOLE: {
        napi_value buffer;
        napi_create_buffer_copy(env, value->value.str.len, value->value.str.val, nullptr, &buffer);
        return buffer;
      }
      default:
        return MakeNull(env);
    }
  }

  napi_value ReadRecord(napi_env env, int recno) {
    int count = PX_get_num_fields(doc_);
    if (count < 0) {
      ThrowLastError(env, TakeError("Failed to read field metadata"));
      return nullptr;
    }

    pxfield_t* fields = PX_get_fields(doc_);
    if (fields == nullptr) {
      ThrowLastError(env, TakeError("Failed to read field metadata"));
      return nullptr;
    }

    pxval_t** values = PX_retrieve_record(doc_, recno);
    if (values == nullptr) {
      ThrowLastError(env, TakeError("Failed to read record"));
      return nullptr;
    }

    napi_value result;
    napi_create_object(env, &result);

    for (int i = 0; i < count; ++i) {
      napi_value js_value = ConvertValue(env, &fields[i], values[i]);
      if (fields[i].px_fname != nullptr) {
        napi_set_named_property(env, result, fields[i].px_fname, js_value);
      }
    }

    FreeRetrievedRecord(doc_, values, count);
    return result;
  }

  static napi_value GetRecord(napi_env env, napi_callback_info info) {
    napi_value argv[1];
    napi_value this_arg;
    Database* self = Unwrap(env, info, &this_arg, 1, argv);
    if (self == nullptr || !self->EnsureOpen(env)) {
      return nullptr;
    }
    if (argv[0] == nullptr) {
      ThrowLastError(env, "Record index is required");
      return nullptr;
    }

    int32_t recno = 0;
    if (!CheckStatus(env, napi_get_value_int32(env, argv[0], &recno))) {
      return nullptr;
    }
    if (recno < 0) {
      ThrowLastError(env, "Record index must be non-negative");
      return nullptr;
    }

    return self->ReadRecord(env, recno);
  }

  static napi_value GetRecords(napi_env env, napi_callback_info info) {
    napi_value argv[2];
    napi_value this_arg;
    Database* self = Unwrap(env, info, &this_arg, 2, argv);
    if (self == nullptr || !self->EnsureOpen(env)) {
      return nullptr;
    }
    if (argv[0] == nullptr || argv[1] == nullptr) {
      ThrowLastError(env, "Start and count are required");
      return nullptr;
    }

    int32_t start = 0;
    int32_t count = 0;
    if (!CheckStatus(env, napi_get_value_int32(env, argv[0], &start)) ||
        !CheckStatus(env, napi_get_value_int32(env, argv[1], &count))) {
      return nullptr;
    }
    if (start < 0 || count < 0) {
      ThrowLastError(env, "Start and count must be non-negative");
      return nullptr;
    }

    napi_value result;
    napi_create_array_with_length(env, count, &result);
    for (int32_t i = 0; i < count; ++i) {
      napi_value record = self->ReadRecord(env, start + i);
      if (record == nullptr) {
        return nullptr;
      }
      napi_set_element(env, result, i, record);
    }
    return result;
  }

  static napi_value Init(napi_env env, napi_value exports) {
    napi_property_descriptor properties[] = {
      {"close", nullptr, Close, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"getInfo", nullptr, GetInfo, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"getFields", nullptr, GetFields, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"getFieldCount", nullptr, GetFieldCount, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"getRecordCount", nullptr, GetRecordCount, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"getRecord", nullptr, GetRecord, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"getRecords", nullptr, GetRecords, nullptr, nullptr, nullptr, napi_default, nullptr},
    };

    napi_value constructor;
    napi_define_class(env,
                      "Database",
                      NAPI_AUTO_LENGTH,
                      Constructor,
                      nullptr,
                      sizeof(properties) / sizeof(properties[0]),
                      properties,
                      &constructor);
    napi_set_named_property(env, exports, "Database", constructor);
    return exports;
  }

 private:
  pxdoc_t* doc_ = nullptr;
  std::string last_error_;
};

napi_value Version(napi_env env, napi_callback_info /*info*/) {
  napi_value result;
  napi_create_object(env, &result);
  napi_set_named_property(env, result, "major", MakeInt32(env, PX_get_majorversion()));
  napi_set_named_property(env, result, "minor", MakeInt32(env, PX_get_minorversion()));
  napi_set_named_property(env, result, "patch", MakeInt32(env, PX_get_subminorversion()));
  napi_set_named_property(env, result, "dotted", MakeString(env, PXLIB_DOTTED_VERSION));
  napi_set_named_property(env, result, "buildDate", MakeString(env, PX_get_builddate()));
  return result;
}

napi_value BuildConstants(napi_env env) {
  napi_value constants;
  napi_create_object(env, &constants);

  napi_set_named_property(env, constants, "pxfAlpha", MakeInt32(env, pxfAlpha));
  napi_set_named_property(env, constants, "pxfDate", MakeInt32(env, pxfDate));
  napi_set_named_property(env, constants, "pxfShort", MakeInt32(env, pxfShort));
  napi_set_named_property(env, constants, "pxfLong", MakeInt32(env, pxfLong));
  napi_set_named_property(env, constants, "pxfCurrency", MakeInt32(env, pxfCurrency));
  napi_set_named_property(env, constants, "pxfNumber", MakeInt32(env, pxfNumber));
  napi_set_named_property(env, constants, "pxfLogical", MakeInt32(env, pxfLogical));
  napi_set_named_property(env, constants, "pxfMemoBLOb", MakeInt32(env, pxfMemoBLOb));
  napi_set_named_property(env, constants, "pxfBLOb", MakeInt32(env, pxfBLOb));
  napi_set_named_property(env, constants, "pxfFmtMemoBLOb", MakeInt32(env, pxfFmtMemoBLOb));
  napi_set_named_property(env, constants, "pxfOLE", MakeInt32(env, pxfOLE));
  napi_set_named_property(env, constants, "pxfGraphic", MakeInt32(env, pxfGraphic));
  napi_set_named_property(env, constants, "pxfTime", MakeInt32(env, pxfTime));
  napi_set_named_property(env, constants, "pxfTimestamp", MakeInt32(env, pxfTimestamp));
  napi_set_named_property(env, constants, "pxfAutoInc", MakeInt32(env, pxfAutoInc));
  napi_set_named_property(env, constants, "pxfBCD", MakeInt32(env, pxfBCD));
  napi_set_named_property(env, constants, "pxfBytes", MakeInt32(env, pxfBytes));

  return constants;
}

napi_value InitAddon(napi_env env, napi_value exports) {
  PX_boot();
  Database::Init(env, exports);

  napi_property_descriptor version_property = {
    "version", nullptr, Version, nullptr, nullptr, nullptr, napi_default, nullptr
  };
  napi_define_properties(env, exports, 1, &version_property);
  napi_set_named_property(env, exports, "constants", BuildConstants(env));
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, InitAddon)

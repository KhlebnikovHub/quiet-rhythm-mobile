package com.hangcreator.mobile;

import com.getcapacitor.BridgeActivity;
import android.os.Bundle;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ExportFilePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
